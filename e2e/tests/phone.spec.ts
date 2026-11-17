import { chat, expect, test } from "../fixtures.ts";

test("chats on a phone, and finds the chat in the chat list", async ({ page, person }) => {
	void person;
	await page.goto("/");
	await chat.send(page, "Hello from a phone");
	await expect(chat.reply(page)).toContainText("You said: Hello from a phone");
	await chat.idle(page);

	// On a phone the chat list is a sheet, opened from the header.
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await expect(page.getByRole("dialog").getByText("Hello from a phone")).toBeVisible();
});

test("an admin on a phone reaches Workspaces, Activity and Settings under More", async ({ page, admin }) => {
	void admin;
	await page.goto("/admin");
	const more = page.locator('[data-slot="mobile-nav"]').getByRole("button", { name: "More" });
	for (const [name, path] of [["Workspaces", "/admin/workspaces"], ["Activity", "/admin/activity"], ["Settings", "/admin/settings"]]) {
		await more.click();
		await page.getByRole("menuitem", { name }).click();
		await expect(page).toHaveURL(new RegExp(`${path}$`));
	}
});
