import { durableServer } from "../durability.ts";
import { chat, expect, test } from "../fixtures.ts";

/**
 * A model call that fails, and is tried again up to 3 attempts.
 * README, "Durable replies".
 * The tests stop their own Ponder, on its own database (e2e/durability.ts), so they run one
 * at a time. Each durability file has its own server, so the files run side by side.
 */
const { setUp, expectWholeReply, modelCalls } = durableServer(2, "retries");

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
