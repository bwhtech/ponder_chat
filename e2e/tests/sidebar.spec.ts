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
