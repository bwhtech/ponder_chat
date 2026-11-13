import type { Page } from "@playwright/test";
import { chat, expect, test, type Fake } from "../fixtures.ts";

/**
 * Compaction (server/compaction/): a chat that gets too long for its model is summarized.
 * The fake gives GLM 5.3 a 40,000-token window (fake/script.ts), so a few long messages
 * reach it. The tests do not depend on the exact message where that happens: they send
 * long messages until the summarizer is called, then check what each side received.
 */
test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
	await page.getByRole("button", { name: /Model/ }).click();
	await page.getByRole("option", { name: /GLM 5\.3/ }).click();
});

/** About `tokens` tokens of plain words. */
const filler = (tokens: number) => Array.from({ length: Math.ceil(tokens / 1.5) }, (_, i) => `note${i % 97}`).join(" ");
const divider = (page: Page) => page.locator('[data-slot="compaction-divider"]');
const longMessage = (marker: string) => `${marker} ${filler(9_000)}`;

/** Sends long messages until the summarizer was called; the number of the message that called it. */
async function chatUntilSummarized(page: Page, fake: Fake, tag: string) {
	for (let i = 1; i <= 8; i++) {
		const marker = `${tag}-M${i}`;
		await fake.chat({ match: marker, steps: [{ text: `Noted ${marker}.` }] });
		await chat.send(page, longMessage(marker));
		await expect(chat.reply(page)).toContainText(`Noted ${marker}.`, { timeout: 60_000 });
		await chat.idle(page);
		if ((await fake.summaries(`${tag}-M1 `)).length) return i;
	}
	throw new Error("The chat was never summarized.");
}

const sent = (messages: unknown[]) => JSON.stringify(messages);

test("a long chat is summarized, and the summary is used again", async ({ page, fake, person, db }) => {
	test.setTimeout(240_000);
	await fake.summary({ match: "SUM-M1 ", text: "SUMMARY-SUM: the person sent long notes.", delayMs: 2_500 });
	const sawCompacting = page.getByText(/Compacting earlier messages/).waitFor({ timeout: 200_000 });

	const at = await chatUntilSummarized(page, fake, "SUM");
	await sawCompacting;
	await expect(divider(page)).toHaveCount(1);

	// The summarizer read the start of the chat, with its own instructions and the chosen model.
	const [summary] = await fake.summaries("SUM-M1 ");
	expect(summary.system).toContain("You write the summary of a chat");
	expect(summary.prompt).toContain("SUM-M1 ");
	expect(summary.model).toBe("deepseek/deepseek-v4.1-flash");

	// The reply read the summary in place of the first message, and the latest message word for word.
	const [call] = await fake.calls(`SUM-M${at} `);
	expect(sent(call.messages)).toContain("SUMMARY-SUM");
	expect(sent(call.messages)).not.toContain("SUM-M1 ");
	expect(sent(call.messages)).toContain(JSON.stringify(longMessage(`SUM-M${at}`)).slice(1, -1));

	// The summary is charged, and is not a reply.
	const [charged] = await db`select count(*)::int as n from charged_runs where "user" = ${person.id} and function_id = 'compaction' and not is_reply`;
	expect(charged.n).toBe(1);

	// The next message reuses the saved summary: no new summary, and the same start.
	await chat.send(page, "SUM-NEXT a short follow-up");
	await expect(chat.reply(page)).toContainText("You said: SUM-NEXT");
	await chat.idle(page);
	expect(await fake.summaries("SUM-M1 ")).toHaveLength(1);
	const [next] = await fake.calls("SUM-NEXT");
	expect(sent(next.messages.slice(0, 2))).toBe(sent(call.messages.slice(0, 2)));

	// Retry after a failed reply keeps the summary too.
	await fake.chat({ match: "SUM-FLAKY", steps: [{ error: { status: 400, message: "The provider refused the request." } }] });
	await chat.send(page, "SUM-FLAKY one more");
	await expect(page.getByText("Something went wrong")).toBeVisible();
	await fake.chat({ match: "SUM-FLAKY", steps: [{ text: "It works now." }] });
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chat.reply(page)).toContainText("It works now.");
	await chat.idle(page);
	expect(await fake.summaries("SUM-M1 ")).toHaveLength(1);

	// The divider stays after a reload.
	await page.reload();
	await expect(divider(page)).toHaveCount(1);
});

test("a summary that fails does not fail the reply, and the next message tries again", async ({ page, fake }) => {
	test.setTimeout(240_000);
	await fake.summary({ match: "FAIL-M1 ", error: { status: 400, message: "The summarizer is down." } });

	const at = await chatUntilSummarized(page, fake, "FAIL");
	await expect(page.getByText("Something went wrong")).toHaveCount(0);
	await expect(divider(page)).toHaveCount(0);
	// The reply was written without the oldest messages, and was told so.
	const [call] = await fake.calls(`FAIL-M${at} `);
	expect(sent(call.messages)).toContain("could not be summarized");
	expect(sent(call.messages)).not.toContain("FAIL-M1 ");

	const tries = (await fake.summaries("FAIL-M1 ")).length;
	await fake.summary({ match: "FAIL-M1 ", text: "SUMMARY-FAIL: it works now." });
	await fake.chat({ match: "FAIL-AGAIN", steps: [{ text: "Noted again." }] });
	await chat.send(page, longMessage("FAIL-AGAIN"));
	await expect(chat.reply(page)).toContainText("Noted again.", { timeout: 60_000 });
	await chat.idle(page);
	expect((await fake.summaries("FAIL-M1 ")).length).toBeGreaterThan(tries);
	await expect(divider(page)).toHaveCount(1);
});

test("a reply whose tool calls grow too long is summarized between its steps", async ({ page, fake }) => {
	test.setTimeout(180_000);
	await fake.summary({ match: "STEP-M1 ", text: "SUMMARY-STEP: the person sent long notes." });
	await fake.chat({ match: "STEP-M1", steps: [{ text: "Noted STEP-M1." }] });
	await chat.send(page, `STEP-M1 ${filler(12_000)}`);
	await expect(chat.reply(page)).toContainText("Noted STEP-M1.", { timeout: 60_000 });
	await chat.idle(page);

	const content = filler(22_000);
	await fake.chat({
		match: "STEP-WRITE",
		steps: [
			{ toolCalls: [{ name: "write_artifact", input: { id: "big-notes", kind: "document", title: "Big notes", content } }], delayMs: 0 },
			{ text: "STEP-DONE: I wrote the notes." },
		],
	});
	await chat.send(page, "STEP-WRITE put all of that in a document");
	await expect(chat.reply(page)).toContainText("STEP-DONE", { timeout: 90_000 });
	await chat.idle(page);

	const calls = await fake.calls("STEP-WRITE");
	expect(calls).toHaveLength(2);
	// The first call read the first message; the second, after the long artifact, read the summary instead.
	expect(sent(calls[0].messages)).toContain("STEP-M1 ");
	expect(sent(calls[1].messages)).toContain("SUMMARY-STEP");
	expect(sent(calls[1].messages)).not.toContain("STEP-M1 ");
	expect(sent(calls[1].messages)).toContain("big-notes");
	await expect(divider(page)).toHaveCount(1);
});

test("a message too long for the model says so", async ({ page, fake }) => {
	await chat.send(page, `HUGE-M1 ${filler(45_000)}`);
	await expect(page.getByText("This message is too long for GLM 5.3")).toBeVisible({ timeout: 60_000 });
	expect(await fake.calls("HUGE-M1")).toHaveLength(0);
});
