import { expect, test } from "../fixtures.ts";

test("the sidebar stays closed after a reload, and opens again", async ({ page, person }) => {
	void person;
	await page.goto("/");
	const sidebar = page.getByRole("navigation", { name: "Chats" });
	await sidebar.getByRole("button", { name: "Collapse", exact: true }).click();
	await expect(sidebar).toHaveCSS("width", "48px");
	await page.reload();
	await expect(sidebar).toHaveCSS("width", "48px");
	await sidebar.getByRole("button", { name: "Expand", exact: true }).click();
	await expect(sidebar).toHaveCSS("width", "256px");
});

test("the closed sidebar previews over the chat while pointed at", async ({ page, person }) => {
	void person;
	await page.goto("/");
	const sidebar = page.getByRole("navigation", { name: "Chats" });
	const chatLeft = async () => (await page.locator('[data-slot="chat-column"]').boundingBox())?.x;
	await sidebar.getByRole("button", { name: "Collapse", exact: true }).click();
	await expect.poll(chatLeft).toBe(48);
	await sidebar.getByRole("button", { name: "Expand", exact: true }).hover();
	await expect(sidebar).toHaveCSS("width", "256px");
	expect(await chatLeft()).toBe(48);
	await page.mouse.move(800, 400);
	await expect(sidebar).toHaveCSS("width", "48px");
});
