import { chat, expect, test } from "../fixtures.ts";

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
