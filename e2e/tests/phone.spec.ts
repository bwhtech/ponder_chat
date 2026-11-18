import type { Page } from "@playwright/test";
import { chat, expect, test } from "../fixtures.ts";
import { addChats, createWorkspace, textFile, uploadReady, workspacePage } from "../workspaces.ts";

const aside = (page: Page) => page.locator('[data-slot="workspace-aside"]');

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

test("on a phone, a workspace's message box sits where the chat's does: the page scrolls clear of it, and asking does not move it", async ({ page, person, db }) => {
	const tag = person.id.slice(0, 6);
	const question = `When is the exit site cleaned, ${tag}?`;
	const { id, slug } = await createWorkspace(page, `Renal ward ${tag}`);
	await uploadReady(page, id, textFile("Exit-site care.md", "# Exit-site care\n\nClean the exit site every second day."));
	await uploadReady(page, id, textFile("Night handover.md", "# Night handover\n\nCheck the exit sites at 22:00."));
	await addChats(db, person.id, id, 12);
	await page.goto(`/?w=${slug}`);
	const box = workspacePage.box(page);
	await expect(page.locator('[data-slot="workspace-chats"] li')).toHaveCount(12);
	await expect(aside(page).locator('[data-slot="document-name"]')).toHaveCount(2);
	const top = (await box.boundingBox())!.y;

	// Under the chats come the side panel's sections; at the end, the last document is clear of the box.
	await workspacePage.scrollToEnd(page);
	await expect(box).toBeInViewport({ ratio: 1 });
	expect((await box.boundingBox())!.y).toBeCloseTo(top, 0);
	const lastDocument = aside(page).locator('[data-slot="document-name"]').last();
	expect(await workspacePage.reachable(lastDocument)).toBe(true);
	await lastDocument.click();
	await expect(page.locator('[data-slot="side-panel"]')).toContainText("Check the exit sites at 22:00.");
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-slot="side-panel"]')).toHaveCount(0);

	await workspacePage.field(page).fill(question);
	await workspacePage.field(page).press("Enter");
	await expect(page).toHaveURL(/[?&]t=/);
	await expect(chat.reply(page)).toContainText(`You said: ${question}`);
	await chat.idle(page);
	// The chat's empty box is where the page's empty box was.
	expect(Math.abs((await page.locator('[data-slot="prompt-input"]').boundingBox())!.y - top)).toBeLessThanOrEqual(2);
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
