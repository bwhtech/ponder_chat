import { durableServer } from "../durability.ts";
import { chat, expect, test } from "../fixtures.ts";

/**
 * A server that a deploy stops (SIGTERM) during a model call, and Stop during one.
 * README, "Durable replies".
 * The tests stop their own Ponder, on its own database (e2e/durability.ts), so they run one
 * at a time. Each durability file has its own server, so the files run side by side.
 */
const { server, setUp, expectWholeReply, modelCalls } = durableServer(1, "deploy");

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

test("Stop keeps the stopped call's cost, and charges it", async ({ page, fake }, testInfo) => {
	const { person, tag, words } = await setUp(page, fake, testInfo.title);
	await fake.chat({ match: tag, steps: [{ text: words, delayMs: 150, cost: 0.0003 }] });

	await chat.send(page, `Tell the ${tag} story`);
	await expect(chat.reply(page)).toContainText(`${tag}-3`);
	await chat.stop(page).click();
	await chat.idle(page);

	// The call runs to its end on OpenRouter: its row gets the cost, and the person is charged it.
	await expect.poll(() => modelCalls(person), { timeout: 30_000 }).toEqual([{ finish_reason: "stopped", cost_usd: 0.0003, charged: true }]);
});
