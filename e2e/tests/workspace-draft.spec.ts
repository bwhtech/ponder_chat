import { chat, expect, test } from "../fixtures.ts";
import { createWorkspace, workspacePage } from "../workspaces.ts";

/**
 * What a person types in a workspace page's message box is kept as a draft (drafts.ts), and
 * sending it clears the draft: back on the page, the box is empty. The page leaves for the new
 * chat as the question is sent, so the clearing must not wait for the page to save it later.
 */
test("a question sent from a workspace page leaves no draft behind when the person comes back", async ({ page, person }) => {
	const name = `Rota ${person.id.slice(0, 6)}`;
	const question = `Who is on call on Friday, ${person.id.slice(0, 6)}?`;
	const workspace = await createWorkspace(page, name);
	await page.goto(`/?w=${workspace.slug}`);

	// Typed slowly enough that the draft is saved before it is sent.
	await workspacePage.field(page).fill(question);
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ponder-chat:drafts:v1") ?? "")).toContain("on call on Friday");
	await workspacePage.field(page).press("Enter");
	await expect(chat.messages(page).filter({ hasText: question }).first()).toBeVisible();

	// Back to the workspace by the chat's breadcrumb: the box is empty.
	await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name }).click();
	await expect(page).toHaveURL(new RegExp(`[?&]w=${workspace.slug}`));
	await expect(workspacePage.field(page)).toHaveValue("");

	// And it stays empty after a reload: no draft is kept for it.
	await page.reload();
	await expect(workspacePage.field(page)).toBeVisible();
	await expect(workspacePage.field(page)).toHaveValue("");
});
