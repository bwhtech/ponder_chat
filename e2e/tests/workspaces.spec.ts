import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { chat, expect, test } from "../fixtures.ts";
import { addChats, createSkill, createWorkspace, newPerson, textFile, uploadReady, workspacePage } from "../workspaces.ts";

/**
 * Workspaces and sharing (docs/workspaces-plan.md, "Tests"): a person makes a workspace with
 * instructions and shares it; the people in it ask with those instructions; nobody else can
 * find it; chats stay their writers' own; and a person who is removed can read their chat
 * but not send in it. An admin's workspace for everyone shows for everyone. The owner renames
 * a workspace by its title, and adds or edits its instructions, in Markdown, from their own
 * section. A person who can only ask sees no controls there, and no empty sections.
 *
 * While the person has no chat in a workspace, its page guides them where the chats will be:
 * setup steps for whoever can edit it, each opening the same dialog, file picker or Share as
 * the side panel and the header, then first questions made from its documents, which fill
 * the message box.
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
		// No chat of B's in it yet: no "Your chats". B can only ask: no setup steps, and with no documents, no first questions either.
		await expect(b.page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);
		await expect(b.page.locator('[data-slot="workspace-starters"]')).toHaveText(`Ask a question about ${name} below.`);
		await expect(setup(b.page)).toHaveCount(0);

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

		// The header's breadcrumb: the workspace, then the chat, which is the page's heading.
		const breadcrumb = b.page.getByRole("navigation", { name: "Breadcrumb" });
		await expect(breadcrumb.getByRole("link", { name })).toHaveAttribute("href", `/?w=${new URL(workspaceUrl).searchParams.get("w")}`);
		await expect(breadcrumb).toContainText("How many days of leave");
		await expect(b.page.getByRole("heading", { name: /How many days of leave/, level: 1 })).toHaveCount(1);

		// Back to the workspace by the header: its page lists B's own chat.
		await breadcrumb.getByRole("link", { name }).click();
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
	// Everyone uses it already: its People step is done from the start, and the instructions from the dialog too.
	await expect(setup(page).getByRole("heading", { name: `Set up ${name}` })).toBeVisible();
	await expect(setupCount(page)).toHaveText("2 of 3");
	await expect(step(page, "people")).toHaveAttribute("data-done", "true");
	await expect(step(page, "people")).toContainText("Everyone in the organisation");
	await expect(step(page, "documents")).not.toHaveAttribute("data-done");
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
		// Nor do they see its setup steps: one line points to the box.
		await expect(other.page.locator('[data-slot="workspace-starters"]')).toHaveText(`Ask a question about ${name} below.`);
		await expect(setup(other.page)).toHaveCount(0);
		await other.context.close();
	}
});

test("a new workspace guides its owner: setup steps tick one by one, then first questions fill the box, until the first chat", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const name = `HR Policies ${tag}`;
	const marker = `Answer from the HR handbook, ref ${tag}.`;
	const other = await newPerson(browser, db, fake, "joins hr");
	const field = workspacePage.field(page);

	await test.step("A new private workspace shows its three steps, none done, where the chats will be", async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "New workspace", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "New workspace" });
		await dialog.getByLabel("Name").fill(name);
		await dialog.getByRole("button", { name: "Create workspace" }).click();
		await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(setup(page).getByRole("heading", { name: `Set up ${name}` })).toBeVisible();
		await expect(setupCount(page)).toHaveText("0 of 3");
		await expect(setup(page).getByRole("button")).toHaveText([/^Instructions/, /^Documents/, /^People/]);
		// The steps add what the side panel's empty areas would, so the panel shows none of them.
		await expect(aside(page).getByRole("button", { name: "Add instructions" })).toHaveCount(0);
		await expect(aside(page).locator('[data-slot="document-upload-area"]')).toHaveCount(0);
		await expect(page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);
	});

	await test.step("Add instructions, from its step with the keyboard: the step ticks, and shows what was added", async () => {
		await setup(page).getByRole("button", { name: "Add instructions" }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Instructions" });
		await dialog.getByRole("textbox", { name: "Instructions" }).fill(`${marker}\nKeep answers short.`);
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(step(page, "instructions")).toHaveAttribute("data-done", "true");
		await expect(step(page, "instructions")).toContainText(marker);
		await expect(setupCount(page)).toHaveText("1 of 3");
		await expect(setup(page).getByRole("button", { name: "Edit instructions" })).toBeVisible();
		await expect(instructionsSection(page)).toContainText(marker);
	});

	await test.step("Upload documents, from its step: the step ticks, and the document shows in the side panel", async () => {
		const chooser = page.waitForEvent("filechooser");
		await setup(page).getByRole("button", { name: "Upload documents" }).click();
		await (await chooser).setFiles(textFile("Leave policy.md", `# Leave policy\n\nStaff get 27 days of paid leave a year, ${tag}.`));
		await expect(step(page, "documents")).toHaveAttribute("data-done", "true");
		await expect(step(page, "documents")).toContainText("1 document");
		await expect(setupCount(page)).toHaveText("2 of 3");
		await expect(aside(page).locator('[data-slot="workspace-document"]')).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	});

	await test.step("Share, from its step: once shared, first questions made from the document take the steps' place", async () => {
		await setup(page).getByRole("button", { name: "Share workspace" }).click();
		const share = page.getByRole("dialog", { name: `Share “${name}”` });
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(other.person.email);
		await page.getByRole("option", { name: new RegExp(escape(other.person.email)) }).click();
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(starters(page)).toHaveText(["Summarise “Leave policy.md”", `What can I ask about in ${name}?`]);
		await expect(setup(page)).toHaveCount(0);
	});

	await test.step("A first question fills the box, and nothing is sent until the person sends it", async () => {
		await starters(page).first().click();
		await expect(field).toBeFocused();
		await expect(field).toHaveValue("Summarise “Leave policy.md”");
		expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart === element.value.length)).toBe(true);
		await expect(page).not.toHaveURL(/[?&]t=/);
		await field.press("Enter");
		await expect(page).toHaveURL(/[?&]t=/);
		await expect(chat.reply(page)).toContainText("Leave policy");
		await chat.idle(page);
		const [call] = await fake.calls("Summarise “Leave policy.md”");
		expect(call.system).toContain(marker);
	});

	await test.step("Back on the workspace: its chats, no guide, and the side panel's own Upload and Instructions", async () => {
		await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name }).click();
		await expect(page.locator('[data-slot="workspace-chats"]')).toContainText("Leave policy");
		await expect(setup(page)).toHaveCount(0);
		await expect(page.locator('[data-slot="workspace-starters"]')).toHaveCount(0);
		await expect(instructionsSection(page).getByRole("button", { name: "Edit instructions" })).toBeVisible();
		await expect(aside(page).locator('[data-slot="workspace-documents"]').getByRole("button", { name: "Upload", exact: true })).toBeVisible();
	});

	await other.context.close();
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
		// No chat here yet: the side panel has no empty Instructions; the setup step adds them.
		await expect(instructionsSection(page)).toHaveCount(0);
		await setup(page).getByRole("button", { name: "Add instructions" }).click();
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
		await editor.fill(`## Rota rules\n\n${first} Use **bold** for names. See [the rota](https://example.test/rota).`);
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
		await expect(editor).toContainText(`${first} Use **bold** for names. See [the rota](https://example.test/rota). Added.`);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(instructionsSection(page)).not.toContainText("Added.");

		// The keyboard reaches the box, and Enter opens them too. The link in the text is for
		// reading here: Shift+Tab from the box goes past it, not into it.
		await box.focus();
		await page.keyboard.press("Shift+Tab");
		await expect(page.locator('[data-slot="workspace-instructions"] :focus')).toHaveCount(0);
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

test("the message box floats at the bottom of a workspace page, beside the side panel; a question there, with a skill, opens its chat", async ({ page, admin, db, fake }) => {
	const tag = admin.id.slice(0, 6);
	const name = `Renal ward ${tag}`;
	const question = `How often is the exit site cleaned, ${tag}?`;
	const marker = `Write a shift handover, ref ${tag}.`;
	const { id, slug } = await createWorkspace(page, name);
	await uploadReady(page, id, textFile("Exit-site care.md", "# Exit-site care\n\nClean the exit site every second day."));
	const chats = await addChats(db, admin.id, id, 20);
	const skill = `handover-${tag.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
	await createSkill(page, skill, "Turn ward notes into a shift handover.", marker);
	await page.goto(`/?w=${slug}`);
	const box = workspacePage.box(page);
	await expect(page.locator('[data-slot="workspace-chats"] li')).toHaveCount(20);

	await test.step("Scrolled to the end, the box is in view, clear of the side panel, and the last chat can be clicked", async () => {
		await workspacePage.scrollToEnd(page);
		await expect(box).toBeInViewport({ ratio: 1 });
		const boxRect = (await box.boundingBox())!;
		const asideRect = (await aside(page).boundingBox())!;
		expect(boxRect.x + boxRect.width).toBeLessThanOrEqual(asideRect.x);
		const last = page.locator('[data-slot="workspace-chats"] li button').last();
		expect(await workspacePage.reachable(last)).toBe(true);
	});

	await test.step("Tab through the chats from the top: each one shows clear of the box", async () => {
		const chatButtons = page.locator('[data-slot="workspace-chats"] li button');
		await page.locator('[data-slot="workspace-view"]').evaluate((view) => view.scrollTo({ top: 0 }));
		await chatButtons.first().focus();
		const last = await chatButtons.last().elementHandle();
		for (let presses = 0; presses < 80; presses++) {
			const focused = await page.evaluate(() => {
				const active = document.activeElement;
				if (!active?.closest('[data-slot="workspace-chats"]')) return null;
				const { top, bottom } = active.getBoundingClientRect();
				return { top, bottom, label: active.textContent?.trim() ?? "" };
			});
			if (focused) expect(focused.bottom, `“${focused.label}” is under the box`).toBeLessThanOrEqual((await box.boundingBox())!.y);
			if (await page.evaluate((end) => document.activeElement === end, last)) break;
			await page.keyboard.press("Tab");
		}
		expect(await page.evaluate((end) => document.activeElement === end, last)).toBe(true);
	});

	await test.step("$ opens the skills above the box, and one is chosen", async () => {
		await workspacePage.field(page).click();
		await page.keyboard.type(`$${skill}`);
		const option = page.getByRole("listbox", { name: "Skills" }).getByRole("option").first();
		await expect(option).toBeVisible();
		expect((await option.boundingBox())!.y).toBeLessThan((await box.boundingBox())!.y);
		await option.click();
		await expect(box.locator('[data-slot="skill-chip"]')).toHaveCount(1);
	});

	await test.step("The question opens the chat as sent: no greeting, the question at once, then the reply", async () => {
		// Whether the new chat's greeting ever shows, from now on.
		await page.evaluate(() => {
			const seen = { greeting: false };
			Object.assign(window, { seen });
			new MutationObserver(() => (seen.greeting ||= Boolean(document.querySelector('[data-slot="conversation-empty-state"]')))).observe(document.body, { childList: true, subtree: true });
		});
		await workspacePage.field(page).fill(question);
		await workspacePage.field(page).press("Enter");
		await expect(page).toHaveURL(/[?&]t=/);
		await expect(page.locator('[data-slot="message"][data-role="user"]')).toContainText(question);
		await expect(page.locator('[data-slot="message"][data-role="user"] [data-slot="skill-chip"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="chat-breadcrumb"]')).toContainText(name);
		await expect(chat.reply(page)).toContainText(question);
		await chat.idle(page);
		expect(await page.evaluate(() => (window as unknown as { seen: { greeting: boolean } }).seen.greeting)).toBe(false);
		const [call] = await fake.calls(question);
		expect(JSON.stringify(call.messages)).toContain(marker);
	});

	await test.step("Back on the workspace, the last chat opens from the end of the list", async () => {
		await page.goto(`/?w=${slug}`);
		await expect(page.locator('[data-slot="workspace-chats"] li')).toHaveCount(21);
		await workspacePage.scrollToEnd(page);
		await page.locator('[data-slot="workspace-chats"] li button').last().click();
		await expect(page).toHaveURL(new RegExp(`[?&]t=${chats.at(-1)}`));
	});
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
const setup = (page: Page) => page.locator('[data-slot="workspace-setup"]');
const setupCount = (page: Page) => page.locator('[data-slot="workspace-setup-count"]');
const step = (page: Page, key: "instructions" | "documents" | "people") => page.locator(`[data-slot="workspace-setup-step"][data-step="${key}"]`);
const starters = (page: Page) => page.locator('[data-slot="workspace-starter"]');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
