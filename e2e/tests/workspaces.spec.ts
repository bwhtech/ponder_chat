import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { chat, expect, test } from "../fixtures.ts";
import { createWorkspace, newPerson } from "../workspaces.ts";

/**
 * Workspaces and sharing (docs/workspaces-plan.md, "Tests"): a person makes a workspace with
 * instructions and shares it; the people in it ask with those instructions; nobody else can
 * find it; chats stay their writers' own; and a person who is removed can read their chat
 * but not send in it. An admin's workspace for everyone shows for everyone. The owner renames
 * a workspace by its title, and adds or edits its instructions, in Markdown, from their own
 * section. A person who can only ask sees no controls there, and no empty sections.
 *
 * The fake model echoes the first line of a workspace's instructions (fake/server.ts), so a
 * reply shows that they reached the model.
 */

test("a private workspace: made, shared, asked in, hidden from others, and taken back", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const a = { page, person };
	const b = await newPerson(browser, db, fake, "member b");
	const c = await newPerson(browser, db, fake, "outsider c");
	const name = `Leave policies ${person.id.slice(0, 6)}`;
	const marker = `Cite the leave policy, ref ${person.id.slice(0, 6)}.`;
	const question = `How many days of leave do I get, ${person.id.slice(0, 6)}?`;
	let workspaceUrl = "";
	let chatId = "";

	await test.step("1. A makes a private workspace with instructions and shares it with B", async () => {
		await a.page.goto("/");
		await a.page.getByRole("button", { name: "New workspace" }).click();
		const dialog = a.page.getByRole("dialog", { name: "New workspace" });
		await dialog.getByLabel("Name").fill(name);
		// No description to ask for.
		await expect(dialog.getByLabel(/Description/)).toHaveCount(0);
		await dialog.getByLabel("Instructions").fill(`${marker}\nKeep answers short.`);
		// Not an admin: no choice of who can use it.
		await expect(dialog.getByLabel("Who can use it")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Create workspace" }).click();

		// The address has the workspace's slug, made from its name.
		await expect(a.page).toHaveURL(/[?&]w=leave-policies-/);
		workspaceUrl = a.page.url();
		await expect(a.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(workspaceRows(a.page).getByRole("button", { name })).toBeVisible();
		await expect(aside(a.page).getByText(marker)).toBeVisible();
		// Only its owner uses it so far.
		await expect(aside(a.page).locator('[data-slot="workspace-member"]')).toHaveCount(0);

		await a.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = a.page.getByRole("dialog", { name: `Share “${name}”` });
		// Nothing to save until someone is added.
		await expect(share.getByRole("button", { name: "Save" })).toBeDisabled();
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(b.person.email);
		await a.page.getByRole("option", { name: new RegExp(escape(b.person.email)) }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toContainText(b.person.email);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(aside(a.page).locator('[data-slot="workspace-member"]')).toContainText("Can ask");
	});

	await test.step("2. B sees it in the sidebar and asks with its instructions", async () => {
		await b.page.goto("/");
		await workspaceRows(b.page).getByRole("button", { name }).click();
		await expect(b.page).toHaveURL(workspaceUrl);
		await expect(b.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(aside(b.page).getByText("Can ask", { exact: true })).toBeVisible();
		// Only the owner shares or deletes; B can only ask, so B changes nothing.
		await expect(b.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(b.page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
		// The title is plain text, and the instructions have no editor.
		await expect(b.page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
		await expect(instructionsSection(b.page)).toContainText(marker);
		await expect(instructionsSection(b.page).getByRole("button")).toHaveCount(0);
		// No documents, and nothing to add them with: no Documents.
		await expect(aside(b.page).locator('[data-slot="workspace-documents"]')).toHaveCount(0);
		// No chat of B's in it yet: no "Your chats".
		await expect(b.page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);

		await chat.send(b.page, question);
		await expect(b.page).toHaveURL(/[?&]t=/);
		chatId = new URL(b.page.url()).searchParams.get("t")!;
		await expect(chat.reply(b.page)).toContainText(`Workspace “${name}” says: ${marker}`);
		await chat.idle(b.page);
		// The chat is in the workspace: its header links to it, and its composer names it.
		await expect(b.page.locator('[data-slot="chat-breadcrumb"]')).toContainText(name);
		await expect(chat.field(b.page)).toHaveAttribute("placeholder", new RegExp(`^Ask in ${escape(name)}`));
		const [call] = await fake.calls(question);
		expect(call.system).toContain(marker);

		// Back to the workspace by the header: its page lists B's own chat.
		await b.page.locator('[data-slot="chat-breadcrumb"]').getByRole("link", { name }).click();
		await expect(b.page).toHaveURL(workspaceUrl);
		await expect(b.page.locator('[data-slot="workspace-chats"]')).toContainText("How many days of leave");
	});

	await test.step("3. C gets not found for the same address", async () => {
		await c.page.goto(workspaceUrl);
		await expect(c.page.getByText("No workspace here")).toBeVisible();
		await expect(c.page.getByText(marker)).toHaveCount(0);
		await expect(workspaceRows(c.page).getByRole("button", { name })).toHaveCount(0);
		const slug = new URL(workspaceUrl).searchParams.get("w")!;
		expect((await c.page.request.get(`/api/workspaces/${slug}`)).status()).toBe(404);
		expect((await c.page.request.get("/api/workspaces/no-such-workspace")).status()).toBe(404);
	});

	await test.step("4. A cannot open B's chat in the workspace", async () => {
		await a.page.goto(workspaceUrl);
		await expect(aside(a.page).getByText(marker)).toBeVisible();
		await expect(a.page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);
		await a.page.goto(`/?t=${chatId}`);
		await expect(a.page.locator('[data-slot="prompt-input"]')).toBeVisible();
		await expect(chat.messages(a.page)).toHaveCount(0);
		await expect(a.page.getByText(question)).toHaveCount(0);
		expect(await (await a.page.request.get(`/api/threads/${chatId}`)).json()).toEqual({ messages: [], running: false });
	});

	await test.step("5. A removes B: B can still read the chat, but not send in it", async () => {
		await a.page.goto(workspaceUrl);
		await a.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = a.page.getByRole("dialog", { name: `Share “${name}”` });
		await expect(share.getByRole("button", { name: "Save" })).toBeDisabled();
		await share.locator('[data-slot="workspace-member"]').getByRole("button", { name: /^Remove / }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(0);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(aside(a.page).locator('[data-slot="workspace-member"]')).toHaveCount(0);

		await b.page.goto(`/?t=${chatId}`);
		await expect(b.page.locator('[data-slot="message"][data-role="user"]')).toHaveText(question);
		await expect(chat.reply(b.page)).toContainText(marker);
		await expect(b.page.locator('[data-slot="workspace-access-lost"]')).toContainText("You no longer have access to this chat's workspace.");
		await expect(chat.field(b.page)).toBeDisabled();
		await expect(workspaceRows(b.page).getByRole("button", { name })).toHaveCount(0);
		// The server refuses the message too, with the words the page shows.
		const sent = await b.page.request.post("/api/chat", {
			data: { id: chatId, messages: [{ id: "lost-1", role: "user", parts: [{ type: "text", text: "One more question" }] }] },
			headers: { origin: e2e.baseUrl },
		});
		expect(sent.status()).toBe(403);
		expect(await sent.text()).toContain("You can read this chat, but not send in it.");
	});

	await b.context.close();
	await c.context.close();
});

test("an admin makes a workspace for everyone, and every person sees it", async ({ page, admin, fake, db, browser }) => {
	const name = `Company handbook ${admin.id.slice(0, 6)}`;
	await page.goto("/");
	await page.getByRole("button", { name: "New workspace" }).click();
	const dialog = page.getByRole("dialog", { name: "New workspace" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByLabel("Instructions").fill("Answer from the handbook.");
	await dialog.getByLabel("Who can use it").click();
	await page.getByRole("option", { name: "Everyone in the organisation" }).click();
	await dialog.getByRole("button", { name: "Create workspace" }).click();
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	await expect(aside(page).getByText("Everyone in the organisation", { exact: true })).toBeVisible();
	const workspaceUrl = page.url();

	for (const title of ["first person", "second person"]) {
		const other = await newPerson(browser, db, fake, title);
		await other.page.goto("/");
		await workspaceRows(other.page).getByRole("button", { name }).click();
		await expect(other.page).toHaveURL(workspaceUrl);
		await expect(other.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(aside(other.page).getByText("Everyone in the organisation", { exact: true })).toBeVisible();
		// Everyone asks; only admins change it.
		await expect(other.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(other.page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
		await other.context.close();
	}
});

test("the owner renames a workspace by its title or its menu, and adds and edits its instructions on their own", async ({ page, person, fake }) => {
	const tag = person.id.slice(0, 6);
	const name = `Ward rota ${tag}`;
	const renamed = `Night rota ${tag}`;
	const first = `Answer from the rota, ref ${tag}.`;
	const second = `Answer from the night rota, ref ${tag}.`;
	const question = `Who is on nights this week, ${tag}?`;
	const { slug } = await createWorkspace(page, name);
	await page.goto(`/?w=${slug}`);
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	const field = page.getByRole("textbox", { name: "Workspace name" });

	await test.step("Escape keeps the name, and so does an empty one", async () => {
		await page.getByRole("button", { name: "Rename", exact: true }).click();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(name);
		await field.fill("Not this name");
		await field.press("Escape");
		await expect(field).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeFocused();
		await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

		await page.keyboard.press("Enter");
		await field.fill("  ");
		await field.press("Enter");
		await expect(field).toHaveCount(0);
		await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	});

	await test.step("Rename in the ⋯ menu opens the same field; Enter renames it, the sidebar follows, and the address keeps its slug", async () => {
		await page.getByRole("button", { name: "Workspace actions" }).click();
		await page.getByRole("menuitem", { name: "Rename" }).click();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue(name);
		await field.fill(renamed);
		await field.press("Enter");
		await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();
		await expect(workspaceRows(page).getByRole("button", { name: renamed })).toBeVisible();
		await expect(workspaceRows(page).getByRole("button", { name })).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(slug)}$`));
		await page.reload();
		await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();
	});

	await test.step("Add instructions opens the Markdown editor; the saved instructions show as Markdown, and their box opens them again", async () => {
		const dialog = page.getByRole("dialog", { name: "Instructions" });
		const editor = dialog.getByRole("textbox", { name: "Instructions" });
		const save = dialog.getByRole("button", { name: "Save" });
		const box = instructionsSection(page).getByRole("button", { name: "Edit instructions" });
		await instructionsSection(page).getByRole("button", { name: "Add instructions" }).click();
		await expect(editor).toBeFocused();
		await expect(dialog.getByLabel("Name")).toHaveCount(0);
		// Save waits for a change; spaces alone are none.
		await expect(save).toBeDisabled();
		await editor.fill("   ");
		await expect(save).toBeDisabled();
		// Past the limit, Save waits too, and the dialog says why.
		await editor.fill("x".repeat(20_001));
		await expect(dialog.getByText("Make the instructions 20,000 characters or fewer.", { exact: false })).toBeVisible();
		await expect(save).toBeDisabled();
		await editor.fill(`## Rota rules\n\n${first} Use **bold** for names.`);
		await expect(save).toBeEnabled();
		await save.click();
		await expect(dialog).toHaveCount(0);
		// Drawn as Markdown: a heading and bold text, not their marks.
		await expect(instructionsSection(page).getByRole("heading", { name: "Rota rules" })).toBeVisible();
		await expect(instructionsSection(page).getByText(first)).toBeVisible();
		await expect(instructionsSection(page).getByText("bold", { exact: true })).toBeVisible();
		await expect(instructionsSection(page)).not.toContainText("**");
		await expect(instructionsSection(page).getByRole("button", { name: "Add instructions" })).toHaveCount(0);

		// A click on the box opens them, with the caret at the end of the text.
		await box.hover();
		await box.click();
		await expect(editor).toBeFocused();
		await expect(editor).toContainText(first);
		await page.keyboard.type(" Added.");
		await expect(editor).toContainText(`${first} Use **bold** for names. Added.`);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(instructionsSection(page)).not.toContainText("Added.");

		// The keyboard reaches the box, and Enter opens them too.
		await box.focus();
		await page.keyboard.press("Enter");
		await expect(editor).toContainText(first);
		await expect(save).toBeDisabled();
		await editor.fill(second);
		await save.click();
		await expect(dialog).toHaveCount(0);
		await expect(instructionsSection(page).getByText(second)).toBeVisible();
		await expect(instructionsSection(page).getByRole("heading", { name: "Rota rules" })).toHaveCount(0);
		// The rename is kept.
		await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();
	});

	await test.step("A chat in it follows the new instructions, under the new name", async () => {
		await chat.send(page, question);
		await expect(chat.reply(page)).toContainText(`Workspace “${renamed}” says: ${second}`);
		await chat.idle(page);
		await expect(page.locator('[data-slot="chat-breadcrumb"]')).toContainText(renamed);
		const [call] = await fake.calls(question);
		expect(call.system).toContain(second);
		expect(call.system).not.toContain(first);
	});
});

test("a workspace made from the Memory page opens in its place", async ({ page, person }) => {
	const name = `From memory ${person.id.slice(0, 6)}`;
	await page.goto("/?view=memory");
	await expect(page.getByRole("heading", { name: "Memory", exact: true, level: 1 })).toBeVisible();
	await page.getByRole("button", { name: "New workspace" }).click();
	const dialog = page.getByRole("dialog", { name: "New workspace" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create workspace" }).click();

	await expect(page).toHaveURL(/[?&]w=/);
	await expect(page).not.toHaveURL(/view=memory/);
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Memory", exact: true, level: 1 })).toHaveCount(0);
	// Back goes to Memory again.
	await page.goBack();
	await expect(page.getByRole("heading", { name: "Memory", exact: true, level: 1 })).toBeVisible();
});

test("an older link by a workspace's id opens it, with the slug in its place", async ({ page, person }) => {
	const name = `Old link ${person.id.slice(0, 6)}`;
	const { id, slug } = await createWorkspace(page, name);
	await page.goto(`/?w=${id}`);
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(slug)}$`));
	await expect(workspaceRows(page).locator('[data-state="active"]')).toHaveText(name);
});

const workspaceRows = (page: Page) => page.locator('[data-slot="workspace-rows"]');
const aside = (page: Page) => page.locator('[data-slot="workspace-aside"]');
const instructionsSection = (page: Page) => aside(page).getByRole("region", { name: "Instructions" });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
