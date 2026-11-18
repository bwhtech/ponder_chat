import type { Page } from "@playwright/test";
import sharp from "sharp";
import { e2e } from "../env.ts";
import type { ReceivedSpan } from "../fake/script.ts";
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

	// The compaction is in the reply's trace, with its outcome and no summary text (server/tracing/).
	const [{ run_id: runId }] = await db`select run_id from thread_runs r join threads t on t.id = r.thread_id where t.owner = ${person.id}`;
	let root: ReceivedSpan | undefined;
	await expect.poll(async () => (root = (await fake.spans()).spans.find((span) => span.name === "invoke_agent ponder" && span.attributes["workflow.run.id"] === runId)), { timeout: 15_000 }).toBeTruthy();
	const { spans, exports } = await fake.spans();
	const compaction = spans.find((span) => span.traceId === root!.traceId && span.name === "compaction.run");
	expect(compaction?.attributes["ponder.outcome"]).toBe("compacted");
	expect(spans.some((span) => span.traceId === root!.traceId && span.name === "chat deepseek/deepseek-v4.1-flash"), "the summarizer's call").toBe(true);
	for (const body of exports) expect(body).not.toContain("SUMMARY-SUM");

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
			// In a few pieces: see toolInputPieces (fake/script.ts).
			{ toolCalls: [{ name: "write_artifact", input: { id: "big-notes", kind: "document", title: "Big notes", content } }], delayMs: 0, toolInputPieces: 10 },
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

test("an image counts as an image, not by its size: a large one is neither refused nor summarized", async ({ page, fake }) => {
	// Noise does not compress: about 1 MB, which counted as text would be over 500,000 tokens.
	const png = await sharp({ create: { width: 640, height: 640, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 80 } } }).png().toBuffer();
	expect(png.length).toBeGreaterThan(400_000);
	await fake.summary({ match: "IMAGE-M1", text: "SUMMARY-IMAGE" });
	await fake.chat({ match: "IMAGE-M1", steps: [{ text: "IMAGE-DONE: a noisy square." }] });
	await page.locator('[data-slot="prompt-input"] input[type="file"]').setInputFiles({ name: "noise.png", mimeType: "image/png", buffer: png });
	await chat.send(page, "IMAGE-M1 what is in this picture?");
	await expect(chat.reply(page)).toContainText("IMAGE-DONE", { timeout: 60_000 });
	await expect(page.getByText(/too long for GLM 5\.3/)).toHaveCount(0);
	expect(await fake.summaries("IMAGE-M1")).toHaveLength(0);
	// The model got the image itself.
	const [call] = await fake.calls("IMAGE-M1");
	expect(sent(call.messages)).toContain("data:image/png;base64,");
});

test("a message too long for the model says so", async ({ page, fake }) => {
	await chat.send(page, `HUGE-M1 ${filler(45_000)}`);
	await expect(page.getByText("This message is too long for GLM 5.3")).toBeVisible({ timeout: 60_000 });
	expect(await fake.calls("HUGE-M1")).toHaveLength(0);
});

test("Retry on the reply that compacted keeps the summary and its divider", async ({ page, fake }) => {
	test.setTimeout(240_000);
	await fake.summary({ match: "RETRY-M1 ", text: "SUMMARY-RETRY: the person sent long notes." });
	// Each message is answered, unless the call carries a summary: then the reply fails once.
	let at = 0;
	for (let i = 1; i <= 8 && !at; i++) {
		const marker = `RETRY-M${i}`;
		await fake.chat({ match: marker, steps: [{ text: `Noted ${marker}.` }], summarized: [{ error: { status: 400, message: "The provider refused the request." } }] });
		await chat.send(page, longMessage(marker));
		await expect(chat.reply(page).getByText(`Noted ${marker}.`).or(page.getByText("Something went wrong"))).toBeVisible({ timeout: 60_000 });
		await chat.idle(page);
		if ((await fake.summaries("RETRY-M1 ")).length) at = i;
	}
	expect(at, "the chat was summarized").toBeGreaterThan(0);
	await expect(page.getByText("Something went wrong")).toBeVisible();

	await fake.chat({ match: `RETRY-M${at}`, steps: [{ text: "RETRY-DONE" }] });
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chat.reply(page)).toContainText("RETRY-DONE", { timeout: 60_000 });
	await chat.idle(page);
	// The retry read the saved summary, wrote no new one, and the page still shows where it ends.
	expect(await fake.summaries("RETRY-M1 ")).toHaveLength(1);
	const calls = await fake.calls(`RETRY-M${at} `);
	expect(sent(calls.at(-1)!.messages)).toContain("SUMMARY-RETRY");
	await expect(divider(page)).toHaveCount(1);
	await page.reload();
	await expect(divider(page)).toHaveCount(1);
});

test("a reply that goes on after an approval is summarized when the approved call made it too long", async ({ page, fake }) => {
	test.setTimeout(180_000);
	const shop = await page.request.post("/api/connectors", { data: { name: "Shop", url: `${e2e.mcpUrl}/open/mcp`, transport: "http", auth: "none" } });
	expect(shop.ok(), await shop.text()).toBe(true);
	await fake.summary({ match: "APPROVE-M1 ", text: "SUMMARY-APPROVE: the person sent long notes." });
	await fake.chat({ match: "APPROVE-M1", steps: [{ text: "Noted APPROVE-M1." }] });
	await chat.send(page, longMessage("APPROVE-M1"));
	await expect(chat.reply(page)).toContainText("Noted APPROVE-M1.", { timeout: 60_000 });
	await chat.idle(page);

	// The model writes a long note. Its first call did not read it, so only the run after the approval is over the trigger.
	const note = `APPROVE-NOTE ${filler(24_000)}`;
	await fake.chat({
		match: "APPROVE-ADD",
		// In a few pieces: see toolInputPieces (fake/script.ts).
		steps: [{ toolCalls: [{ name: "connector_call", input: { tool: "shop__add_note", input: { order: "A1", note } } }], toolInputPieces: 10 }, { text: "APPROVE-UNSUMMARIZED" }],
		summarized: [{ text: "APPROVE-DONE" }],
	});
	await chat.send(page, "APPROVE-ADD put my notes on order A1");
	// A new chat loads the connectors with its first message, after Shop was added, so the question names it.
	const approve = page.getByRole("button", { name: "Allow once", exact: true });
	await expect(approve).toBeVisible({ timeout: 60_000 });
	expect(await fake.summaries("APPROVE-M1 ")).toHaveLength(0);

	await approve.click();
	await expect(chat.reply(page)).toContainText("APPROVE-DONE", { timeout: 90_000 });
	await chat.idle(page);
	expect(await fake.summaries("APPROVE-M1 ")).toHaveLength(1);
	const calls = await fake.calls("APPROVE-ADD");
	expect(calls).toHaveLength(2);
	// The call after the approval read the summary in place of the first message, and the approved call word for word.
	expect(sent(calls[1].messages)).toContain("SUMMARY-APPROVE");
	expect(sent(calls[1].messages)).not.toContain("APPROVE-M1 ");
	expect(sent(calls[1].messages)).toContain("APPROVE-NOTE");
	expect(sent(calls[1].messages)).toContain("Added the note to order A1.");
	// The <connectors> note went with the current message, once, and stayed out of the summary.
	expect(sent(calls[1].messages).split("</connectors>")).toHaveLength(2);
	expect((await fake.summaries("APPROVE-M1 "))[0].prompt).not.toContain("</connectors>");
	await expect(divider(page)).toHaveCount(1);
});

test("Stop during the summary saves nothing, and the next message summarizes again", async ({ page, fake, person, db }) => {
	test.setTimeout(240_000);
	const delayMs = 6_000;
	await fake.summary({ match: "STOP-M1 ", text: "SUMMARY-STOP: the person sent long notes.", delayMs });
	const compacting = page.getByText(/Compacting earlier messages/);
	let stopped = false;
	for (let i = 1; i <= 8 && !stopped; i++) {
		const marker = `STOP-M${i}`;
		await fake.chat({ match: marker, steps: [{ text: `Noted ${marker}.` }] });
		await chat.send(page, longMessage(marker));
		await expect(chat.reply(page).getByText(`Noted ${marker}.`).or(compacting)).toBeVisible({ timeout: 60_000 });
		if (await compacting.isVisible()) {
			await chat.stop(page).click();
			stopped = true;
		}
		await chat.idle(page);
	}
	expect(stopped, "the chat was summarized").toBe(true);

	// The summarizer still answers after Stop, but the stopped run does not save it.
	await expect.poll(async () => (await fake.summaries("STOP-M1 ")).length).toBe(1);
	await page.waitForTimeout(delayMs + 2_000);
	const saved = () => db`select count(*)::int as n from thread_summaries s join threads t on t.id = s.thread_id where t.owner = ${person.id}`;
	expect((await saved())[0].n).toBe(0);
	// The stopped reply had only its compaction status, so it is not saved: the thread ends on the person's message.
	const [thread] = await db<{ messages: { role: string }[] }[]>`select messages from threads where owner = ${person.id}`;
	expect(thread.messages.at(-1)?.role).toBe("user");

	await fake.summary({ match: "STOP-M1 ", text: "SUMMARY-STOP: the person sent long notes." });
	await fake.chat({ match: "STOP-AFTER", steps: [{ text: "Noted STOP-AFTER." }] });
	await chat.send(page, "STOP-AFTER a short follow-up");
	await expect(chat.reply(page)).toContainText("Noted STOP-AFTER.", { timeout: 60_000 });
	await chat.idle(page);
	expect(await fake.summaries("STOP-M1 ")).toHaveLength(2);
	expect((await saved())[0].n).toBe(1);
	expect(sent((await fake.calls("STOP-AFTER"))[0].messages)).toContain("SUMMARY-STOP");
});
