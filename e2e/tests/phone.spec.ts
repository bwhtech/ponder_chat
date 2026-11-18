import type { Page } from "@playwright/test";
import { chat, expect, test } from "../fixtures.ts";
import { addChats, createWorkspace, textFile, uploadReady, workspacePage } from "../workspaces.ts";

const about = (page: Page) => page.locator('[data-slot="workspace-about"]');

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
	await expect(about(page).locator('[data-slot="document-name"]')).toHaveCount(2);
	const top = (await box.boundingBox())!.y;

	// Under the chats come the workspace's sections; at the end, the last document is clear of the box.
	await workspacePage.scrollToEnd(page);
	await expect(box).toBeInViewport({ ratio: 1 });
	expect((await box.boundingBox())!.y).toBeCloseTo(top, 0);
	const lastDocument = about(page).locator('[data-slot="document-name"]').last();
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

test("on a phone, a new workspace's setup cards come first, over its sections, and the box covers none of it", async ({ page, person }) => {
	const tag = person.id.slice(0, 6);
	const name = `Theatre lists ${tag}`;
	const { id, slug } = await createWorkspace(page, name, "Answer from the theatre lists.");
	await uploadReady(page, id, textFile("Monday list.md", "# Monday\n\nHip replacement at 09:00."));
	await uploadReady(page, id, textFile("Tuesday list.md", "# Tuesday\n\nKnee arthroscopy at 10:30."));
	await page.goto(`/?w=${slug}`);
	const setup = page.locator('[data-slot="workspace-setup"]');
	await expect(setup.locator('[data-slot="workspace-setup-count"]')).toHaveText("2 of 3 done");
	// One column: the setup card, then the workspace's sections that have something in them.
	expect((await setup.boundingBox())!.y + (await setup.boundingBox())!.height).toBeLessThan((await about(page).boundingBox())!.y);
	await expect(about(page).locator('[data-slot="document-name"]')).toHaveCount(2);

	await workspacePage.scrollToEnd(page);
	expect(await workspacePage.reachable(about(page).locator('[data-slot="document-name"]').last())).toBe(true);
	await setup.getByRole("button", { name: "Share workspace" }).click();
	await expect(page.getByRole("dialog", { name: `Share “${name}”` })).toBeVisible();
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
