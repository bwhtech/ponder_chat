import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { durableServer } from "../durability.ts";
import { chat, expect, test } from "../fixtures.ts";

/**
 * A run that the workflow runtime ends without Ponder: failed, cancelled, or failed during an approval.
 * README, "Durable replies".
 * The tests stop their own Ponder, on its own database (e2e/durability.ts), so they run one
 * at a time. Each durability file has its own server, so the files run side by side.
 */
const { server, setUp, startSlowReply, endRun, runOf, modelCalls, serverCalls } = durableServer(3, "runs");

test("a run that fails without saving its reply is finished, and the page offers Retry", async ({ page, fake }, testInfo) => {
	const { person, tag } = await startSlowReply(page, fake, testInfo.title);
	// The workflow runtime fails the run outside chatTurn, as a replay that diverged after a deploy does.
	await endRun(person, { eventType: "run_failed", eventData: { error: new TextEncoder().encode("diverged"), errorCode: "REPLAY_DIVERGENCE" } });

	await expect.poll(() => runOf(person), { timeout: 30_000 }).toEqual({ finished: true, failed: true, cancelled: false });
	// The page that follows the reply stops, and offers Retry, without a reload: the sweep ended the run's stream.
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await expect(chat.stop(page)).toHaveCount(0);
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
	// The page that follows the reply stops without a reload.
	await expect(chat.stop(page)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
	await page.reload();
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
	await expect(chat.stop(page)).toHaveCount(0);
	// The call in flight is charged what OpenRouter billed, once the sweep has its cost.
	await expect.poll(async () => (await modelCalls(person)).some((call) => call.finish_reason === "stopped" && call.charged && call.cost_usd !== null), { timeout: 30_000 }).toBe(true);
});

test("an approval sent again after the runtime failed its run in the middle of the call runs nothing", async ({ page, fake }, testInfo) => {
	const { person } = await setUp(page, fake, testInfo.title);
	const order = `SLOW${randomBytes(3).toString("hex")}`;
	const added = await page.request.post("/api/connectors", { data: { name: "Shop", url: `${e2e.mcpUrl}/open/mcp`, transport: "http", auth: "none" } });
	expect(added.ok(), await added.text()).toBe(true);
	await fake.chat({ match: order, steps: [{ toolCalls: [{ name: "connector_call", input: { tool: "shop__add_note", input: { order, note: "Gift wrap" } } }] }, { text: "I added the note." }] });
	await page.goto("/");
	await chat.send(page, `Add a note to order ${order}`);
	const answer = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/chat");
	await page.getByRole("button", { name: "Allow once" }).click();
	const approved: unknown = (await answer).postDataJSON();
	// The test server takes 6 seconds over a SLOW order, and records the call first (e2e/mcp/server.ts).
	await expect.poll(() => serverCalls(page, order)).toHaveLength(1);

	await endRun(person, { eventType: "run_failed", eventData: { error: new TextEncoder().encode("diverged"), errorCode: "REPLAY_DIVERGENCE" } });
	await expect.poll(() => runOf(person), { timeout: 30_000 }).toEqual({ finished: true, failed: true, cancelled: false });
	expect((await page.request.post("/api/chat", { data: approved })).ok()).toBe(true);

	await page.waitForTimeout(7_000);
	expect(await serverCalls(page, order)).toHaveLength(1);
	expect(await runOf(person)).toEqual({ finished: true, failed: true, cancelled: false });
});
