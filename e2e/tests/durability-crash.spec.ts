import { e2e } from "../env.ts";
import { durableServer } from "../durability.ts";
import { chat, expect, test } from "../fixtures.ts";

/**
 * A server that crashes (SIGKILL) during a model call or a connector call.
 * README, "Durable replies".
 * The tests stop their own Ponder, on its own database (e2e/durability.ts), so they run one
 * at a time. Each durability file has its own server, so the files run side by side.
 */
const { server, setUp, runOf, expectWholeReply, modelCalls, serverCalls } = durableServer(0, "crash");

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
