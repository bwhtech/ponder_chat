import { chat, expect, test } from "../fixtures.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("chats on a phone", async ({ page }) => {
	await chat.send(page, "Hello from a phone");
	await expect(chat.reply(page)).toContainText("You said: Hello from a phone");
	await chat.idle(page);
	await expect(chat.field(page)).toHaveValue("");
});

