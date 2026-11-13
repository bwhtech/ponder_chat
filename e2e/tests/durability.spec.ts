import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { createWorld } from "@workflow/world-postgres";
import postgres from "postgres";
import { e2e } from "../env.ts";
import type { McpCall } from "../mcp/calls.ts";
import { newDatabase, PonderServer } from "../ponder.ts";
import { chat, expect, signIn, test, uniqueEmail, type Fake, type Person } from "../fixtures.ts";

/**
 * Replies that outlive their server and their model's errors (README, "Durable replies").
 * A server that stops during a model call (a crash or a deploy) starts that call again
 * when it is back, and the page drops what the cut call wrote. A model call that fails
 * is tried again, up to 3 attempts. A connector call is never run twice.
 *
 * These tests stop their own Ponder, on its own database: one server holds the workflow
 * worker of a database. So they run one at a time.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

const server = new PonderServer(e2e.durabilityPort, e2e.durabilityDatabaseUrl);
let db: postgres.Sql;
test.use({ baseURL: server.url });

test.beforeAll(async () => {
	test.setTimeout(120_000);
	await newDatabase(e2e.durabilityDatabaseUrl);
	db = postgres(e2e.durabilityDatabaseUrl, { onnotice: () => {}, max: 2 });
	await server.start();
});

test.afterAll(async () => {
	await server.stop();
	await db?.end();
});

test("a reply goes on after its server crashes in the middle of a model call", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 250 }] });

	await chat.send(page, `Tell the ${tag} story`);
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await server.stop("SIGKILL");
	await server.start();

	await expectWholeReply(page, tag);
	expect(await fake.calls(tag)).toHaveLength(2);
	// The cut call is kept with what OpenRouter billed (from its generation API, by the sweep), and costs no credits.
	await expect.poll(() => modelCalls(person)).toEqual([
		{ finish_reason: "interrupted", cost_usd: 0.0002, charged: false },
		{ finish_reason: "stop", cost_usd: 0.0002, charged: true },
	]);
});

test("a reply goes on after a deploy stops its server in the middle of a model call", async ({ page, fake }, testInfo) => {
	const { tag, words } = await setUp(page, fake, testInfo.title);
	// Longer than the 10 seconds a stopping server waits for its work (server/startup.ts).
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 600 }] });

	await chat.send(page, `Tell the ${tag} story`);
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await server.stop("SIGTERM");
	await server.start();

	await expectWholeReply(page, tag);
	expect(await fake.calls(tag)).toHaveLength(2);
});

test("a model call that fails in the middle is tried again, and the page drops what it wrote", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ text: words, failFirst: 1, breakAfter: 5 }] });

	await chat.send(page, `Tell the ${tag} story`);

	await expectWholeReply(page, tag);
	expect(await fake.calls(tag)).toHaveLength(2);
	await expect.poll(() => modelCalls(person)).toEqual([
		{ finish_reason: "retried", cost_usd: 0.0002, charged: false },
		{ finish_reason: "stop", cost_usd: 0.0002, charged: true },
	]);
});

test("a model call that keeps failing ends after 3 attempts, with Retry", async ({ page, fake }, testInfo) => {
	const { person, tag } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ error: { status: 503, message: "The provider is overloaded." } }] });

	await chat.send(page, `Ask the ${tag} model`);

	await expect(page.getByText("Something went wrong")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	expect(await fake.calls(tag)).toHaveLength(3);
	// OpenRouter began none of them, so none was billed.
	expect(await modelCalls(person)).toEqual([]);
});

test("a connector call cut by a crash is not run again, and the model is told", async ({ page, fake }, testInfo) => {
	const { tag } = await setUp(page, fake, testInfo.title);
	const added = await page.request.post("/api/connectors", { data: { name: "Shop", url: `${e2e.mcpUrl}/open/mcp`, transport: "http", auth: "none" } });
	expect(added.ok(), await added.text()).toBe(true);
	const order = `SLOW${tag}`;
	await fake.chat({
		match: order,
		steps: [{ toolCalls: [{ name: "connector_call", input: { tool: "shop__find_order", input: { order } } }] }, { text: "I could not tell whether the lookup ran." }],
	});

	await page.goto("/");
	await chat.send(page, `Find order ${order}`);
	// The test server takes 6 seconds over a SLOW order (e2e/mcp/server.ts).
	await expect.poll(() => serverCalls(page, order)).toHaveLength(1);
	await server.stop("SIGKILL");
	await server.start();

	await expect(chat.reply(page)).toContainText("I could not tell whether the lookup ran.", { timeout: 60_000 });
	expect(await serverCalls(page, order)).toHaveLength(1);
	const [, second] = await fake.calls(order);
	expect(JSON.stringify(second.messages)).toContain("may or may not have taken effect");
});

test("a model call tried again in a reply with tools keeps the steps before it", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({
		match: tag,
		steps: [
			{ toolCalls: [{ name: "write_artifact", input: { id: `${tag}-notes`, kind: "document", title: `Notes ${tag}`, content: "- First" } }] },
			{ text: words, failFirst: 1, breakAfter: 5 },
		],
	});

	await chat.send(page, `Write the ${tag} notes`);

	await expectWholeReply(page, tag);
	// reset-step drops only the model call that was tried again, not the document before it.
	await expect(page.getByRole("button", { name: `Open Notes ${tag}` })).toBeVisible();
	expect(await fake.calls(tag)).toHaveLength(3);
	await expect.poll(() => modelCalls(person)).toEqual([
		{ finish_reason: "tool-calls", cost_usd: 0.0002, charged: true },
		{ finish_reason: "retried", cost_usd: 0.0002, charged: false },
		{ finish_reason: "stop", cost_usd: 0.0002, charged: true },
	]);
});

test("a model call that a crash cuts on all 3 attempts ends the reply with Retry", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 250 }] });

	await chat.send(page, `Tell the ${tag} story`);
	for (let attempt = 1; attempt <= 3; attempt++) {
		await expect.poll(async () => (await fake.calls(tag)).length, { timeout: 30_000 }).toBe(attempt);
		// Some of the attempt's words are written before the crash.
		await page.waitForTimeout(1_000);
		await server.stop("SIGKILL");
		await server.start();
	}

	// The runtime does not start a 4th attempt: the reply ends, saved as failed.
	await expect.poll(() => runOf(person), { timeout: 30_000 }).toEqual({ finished: true, failed: true, cancelled: false });
	await page.reload();
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	expect(await fake.calls(tag)).toHaveLength(3);
	await expect.poll(() => modelCalls(person)).toEqual(Array(3).fill({ finish_reason: "interrupted", cost_usd: 0.0002, charged: false }));
});

test("Stop keeps the stopped call's cost, and does not charge it", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 150, cost: 0.0003 }] });

	await chat.send(page, `Tell the ${tag} story`);
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await chat.stop(page).click();
	await chat.idle(page);

	// The call runs to its end on OpenRouter: its row gets the cost, and stays uncharged.
	await expect.poll(() => modelCalls(person), { timeout: 30_000 }).toEqual([{ finish_reason: "stopped", cost_usd: 0.0003, charged: false }]);
});

test("a run that fails without saving its reply is finished, and the page offers Retry", async ({ page, fake }, testInfo) => {
	const { person, tag } = await startSlowReply(page, fake, testInfo.title);
	// The workflow runtime fails the run outside chatTurn, as a replay that diverged after a deploy does.
	await endRun(person, { eventType: "run_failed", eventData: { error: new TextEncoder().encode("diverged"), errorCode: "REPLAY_DIVERGENCE" } });

	await expect.poll(() => runOf(person), { timeout: 30_000 }).toEqual({ finished: true, failed: true, cancelled: false });
	await page.reload();
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await expect(chat.stop(page)).toHaveCount(0);
	// The call in flight is settled, so it is uncharged and the sweep gets its cost.
	await expect.poll(async () => (await modelCalls(person)).some((call) => call.finish_reason === "started")).toBe(false);
});

test("a run cancelled without saving its reply is finished as stopped, with no Retry", async ({ page, fake }, testInfo) => {
	const { person, tag } = await startSlowReply(page, fake, testInfo.title);
	// Stop cancelled the run, and the server stopped before it saved the reply.
	await endRun(person, { eventType: "run_cancelled" });

	await expect.poll(() => runOf(person), { timeout: 30_000 }).toEqual({ finished: true, failed: false, cancelled: true });
	await page.reload();
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
	await expect(chat.stop(page)).toHaveCount(0);
});

/** A signed-in person, and a reply that streams for about 15 seconds: it has written its first words. */
async function startSlowReply(page: Page, fake: Fake, title: string) {
	const { person, tag, words } = await setUp(page, fake, title);
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 250 }] });
	await chat.send(page, `Tell the ${tag} story`);
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	return { person, tag };
}

/** Ends the person's run behind Ponder's back, through the workflow world's own API. */
async function endRun(person: Person, event: Parameters<ReturnType<typeof createWorld>["events"]["create"]>[1]) {
	const [{ run_id }] = await db<{ run_id: string }[]>`select run_id from thread_runs r join threads t on t.id = r.thread_id where t.owner = ${person.id}`;
	const world = createWorld({ connectionString: e2e.durabilityDatabaseUrl });
	await world.events.create(run_id, event);
	await world.close?.();
}

/** Whether the person's latest run is marked finished, failed or cancelled. */
async function runOf(person: Person) {
	const [run] = await db<{ finished: boolean; failed: boolean; cancelled: boolean }[]>`
		select finished_at is not null as finished, failed, cancelled from thread_runs r join threads t on t.id = r.thread_id where t.owner = ${person.id}`;
	return run;
}

/** A signed-in person on the chat page, and a reply of distinct words, so a repeated part shows. */
async function setUp(page: Page, fake: Fake, title: string) {
	const person = await signIn(page, db, fake, uniqueEmail(title), server.url);
	const tag = `t${randomBytes(3).toString("hex")}`;
	const words = Array.from({ length: 60 }, (_, index) => `${tag}-${index}`).join(" ");
	await page.goto("/");
	return { person, tag, words };
}

/** The reply shows every word once: the cut attempt's words are gone, in the page and in the saved thread. */
async function expectWholeReply(page: Page, tag: string) {
	const firstWordOnce = () => expect.poll(async () => count(await chat.reply(page).innerText(), `${tag}-0`)).toBe(1);
	await expect(chat.reply(page)).toContainText(`${tag}-59`, { timeout: 60_000 });
	await chat.idle(page);
	await firstWordOnce();
	// The page goes idle when the stream ends; the run saves the reply a moment later. Reload
	// after that, so the page shows the saved reply and does not swap it in while the test reads it.
	const thread = new URL(page.url()).searchParams.get("t")!;
	await expect
		.poll(async () => {
			const body = (await (await page.request.get(`/api/threads/${thread}`)).json()) as { running?: boolean; messages: unknown[] };
			return !body.running && body.messages.length;
		})
		.toBe(2);
	await page.reload();
	await expect(chat.reply(page)).toContainText(`${tag}-59`);
	await firstWordOnce();
}

/** The person's model calls in `runs`, oldest first, and whether credits count each. */
async function modelCalls(person: Person) {
	return db`
		select finish_reason, cost_usd::float8 as cost_usd, exists (select 1 from charged_runs c where c.id = r.id) as charged
		from runs r where "user" = ${person.id} and function_id = 'chat' order by created_at`;
}

async function serverCalls(page: Page, order: string): Promise<McpCall[]> {
	return (await page.request.get(`${e2e.mcpUrl}/__mcp/calls?match=${order}`)).json();
}

function count(text: string, word: string) {
	return text.split(/\s+/).filter((candidate) => candidate === word).length;
}
