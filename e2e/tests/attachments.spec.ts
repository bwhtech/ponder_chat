import { chat, expect, test } from "../fixtures.ts";
import { slowPdf, textPdf } from "../pdfs.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

const csv = { name: "fruit.csv", mimeType: "text/csv", buffer: Buffer.from("fruit,count\napple,3\npear,7\nplum,2\n") };

test("sends an attached file with the message", async ({ page, fake }) => {
	await page.locator('[data-slot="prompt-input"] input[type="file"]').setInputFiles(csv);
	await chat.send(page, "Which fruit has the most, attachment test?");
	await expect(chat.reply(page)).toContainText("You said:");

	// The field clears once the files are uploaded and the message has gone.
	await expect(chat.field(page)).toHaveValue("");

	const mine = chat.messages(page).nth(-2);
	await expect(mine.locator('a[data-slot="attachment"]')).toContainText("fruit.csv");

	// The model was given what the file holds.
	const [call] = await fake.calls("attachment test");
	expect(JSON.stringify(call.messages)).toContain("pear,7");
});

test("opens an attached CSV as a table in the side panel", async ({ page }) => {
	await page.locator('[data-slot="prompt-input"] input[type="file"]').setInputFiles(csv);
	await chat.send(page, "Here is a table");
	await chat.idle(page);

	await chat.messages(page).nth(-2).locator('a[data-slot="attachment"]').click();
	await expect(page.getByRole("cell", { name: "pear" })).toBeVisible();
});

test("gives the model the text of an attached PDF", async ({ page, fake }) => {
	const lines = ["The quick brown fox jumps over the lazy dog, twice.", "Pack my box with five dozen liquor jugs, and then rest."];
	await page.locator('[data-slot="prompt-input"] input[type="file"]').setInputFiles({ name: "report.pdf", mimeType: "application/pdf", buffer: textPdf(lines) });
	await chat.send(page, "What does the report say, pdf test?");
	await expect(chat.reply(page)).toContainText("You said:");

	// The default model cannot read a PDF, so the server read its text (server/pdf-text.ts).
	const [call] = await fake.calls("pdf test");
	expect(JSON.stringify(call.messages)).toContain(JSON.stringify(`--- Page 1 ---\n${lines[0]}\n\n--- Page 2 ---\n${lines[1]}`).slice(1, -1));
});

test("stops reading a PDF that takes too long, and answers other requests meanwhile", async ({ page, db }) => {
	test.setTimeout(60_000);
	const upload = await page.request.post("/api/files", { multipart: { file: { name: "slow.pdf", mimeType: "application/pdf", buffer: slowPdf() } } });
	expect(upload.ok(), await upload.text()).toBe(true);
	const { id } = (await upload.json()) as { id: string };
	const text = async () => (await db`select text from files where id = ${id}`)[0].text as string | null;

	// The read runs in a worker thread: on the server's own thread, nothing was answered until it ended.
	for (let asked = 0; asked < 5; asked++) {
		const start = Date.now();
		expect((await page.request.get("/health")).ok()).toBe(true);
		expect(Date.now() - start).toBeLessThan(1000);
		expect(await text()).toBeNull();
		await page.waitForTimeout(500);
	}
	// The read is stopped after 20 seconds, and the PDF is kept as one with no text, so it is not read again.
	await expect.poll(text, { timeout: 30_000 }).toBe("");
});
