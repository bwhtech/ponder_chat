import { chat, expect, test } from "../fixtures.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("chats on a phone, and finds the chat in the chat list", async ({ page }) => {
	await chat.send(page, "Hello from a phone");
	await expect(chat.reply(page)).toContainText("You said: Hello from a phone");
	await chat.idle(page);

	// On a phone the chat list is a sheet, opened from the header.
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await expect(page.getByRole("dialog").getByText("Hello from a phone")).toBeVisible();
});
