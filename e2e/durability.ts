import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { createWorld } from "@workflow/world-postgres";
import postgres from "postgres";
import { e2e } from "./env.ts";
import type { McpCall } from "./mcp/calls.ts";
import { newDatabase, PonderServer } from "./ponder.ts";
import { chat, expect, signIn, test, uniqueEmail, type Fake, type Person } from "./fixtures.ts";

/**
 * Replies that outlive their server and their model's errors (README, "Durable replies").
 * A server that stops during a model call (a crash or a deploy) starts that call again
 * when it is back, and the page drops what the cut call wrote. A model call that fails
 * is tried again, up to 3 attempts. A connector call is never run twice.
 *
 * Each durability file (tests/durability-*.spec.ts) stops its own Ponder, on its own database:
 * one server holds the workflow worker of a database. So a file's tests run one at a time,
 * and the files run side by side, each on its own `slot` (env.ts).
 */
export function durableServer(slot: number, name: string) {
	const { port, databaseUrl } = e2e.durability(slot, name);
	const server = new PonderServer(port, databaseUrl);
	let db: postgres.Sql;

	test.describe.configure({ mode: "serial", timeout: 120_000 });
	test.use({ baseURL: server.url });

	test.beforeAll(async () => {
		test.setTimeout(120_000);
		await newDatabase(databaseUrl);
		db = postgres(databaseUrl, { onnotice: () => {}, max: 2 });
		await server.start();
	});

	test.afterAll(async () => {
		await server.stop();
		await db?.end();
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
		const world = createWorld({ connectionString: databaseUrl });
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

	return { server, setUp, startSlowReply, endRun, runOf, expectWholeReply, modelCalls, serverCalls };
}

function count(text: string, word: string) {
	return text.split(/\s+/).filter((candidate) => candidate === word).length;
}
