import type { Locator, Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { chat, expect, jsonOf, test } from "../fixtures.ts";
import { addChats, createSkill, createWorkspace, newPerson, textFile, uploadReady, workspacePage } from "../workspaces.ts";

/**
 * Workspaces and sharing (docs/workspaces-plan.md, "Tests"): a person makes a workspace with
 * instructions and shares it; the people in it ask with those instructions; nobody else can
 * find it; chats stay their writers' own; and a person who is removed can read their chat
 * but not send in it. Share applies each change at once. An admin opens a workspace to
 * everyone, which keeps its people and their roles; everyone else can then ask, not edit.
 * Editors share too, but only admins open or close General access. The owner renames
 * a workspace by its title, and adds or edits its instructions, in Markdown, from their own
 * section. A person who can only ask sees no controls there, and no empty sections.
 *
 * While the person has no chat in a workspace, the workspace's sections are its page. Whoever
 * can edit it also sees a setup card for each step still to do, over them; each card opens the
 * same dialog, file picker or Share as the sections and the header, and leaves once its step
 * is done.
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
		// Every workspace starts private: no choice of who can use it here.
		await expect(dialog.getByLabel("Who can use it")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Create workspace" }).click();

		// The address has the workspace's slug, made from its name.
		await expect(a.page).toHaveURL(/[?&]w=leave-policies-/);
		workspaceUrl = a.page.url();
		await expect(a.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(workspaceRows(a.page).getByRole("button", { name, exact: true })).toBeVisible();
		await expect(about(a.page).getByText(marker)).toBeVisible();
		// Only its owner uses it so far.
		await expect(about(a.page).locator('[data-slot="workspace-member"]')).toHaveCount(0);

		await a.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = a.page.getByRole("dialog", { name: `Share “${name}”` });
		// The owner, and General access as text: A is no admin.
		await expect(share.locator("li").first()).toContainText("You");
		await expect(share.locator("li").first()).toContainText("Owner");
		await expect(share.getByText("Only people added", { exact: true })).toBeVisible();
		await expect(share.getByText("Only an admin can open a workspace to everyone.")).toBeVisible();
		await expect(share.getByRole("button", { name: /^General access/ })).toHaveCount(0);
		await expect(share.getByRole("button", { name: "Save" })).toHaveCount(0);

		// B is added at once, with Can ask, and saved with no Save.
		const saved = a.page.waitForResponse((response) => response.url().includes("/members/") && response.request().method() === "PUT");
		await addPerson(share, b.person.email);
		await expect(share.locator('[data-slot="workspace-member"]')).toContainText(b.person.email);
		await expect(roleButton(share, b.person.email)).toHaveText("Can ask");
		expect((await saved).ok()).toBe(true);
		await expect(about(a.page).locator('[data-slot="workspace-member"]')).toContainText("Can ask");
		await expect(a.page.getByText("Sharing saved")).toHaveCount(0);

		// Copy link puts the page's address on the clipboard, and says so for 2 s.
		await a.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await share.getByRole("button", { name: "Copy link" }).click();
		await expect(share.getByRole("button", { name: "Link copied" })).toBeVisible();
		await expect(share.locator('[aria-live="polite"]').filter({ hasText: "Link copied" })).toHaveCount(1);
		expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(workspaceUrl);
		await expect(share.getByRole("button", { name: "Copy link" })).toBeVisible({ timeout: 4000 });
		await share.getByRole("button", { name: "Done" }).click();
		await expect(share).toHaveCount(0);
	});

	await test.step("2. B sees it in the sidebar and asks with its instructions", async () => {
		await b.page.goto("/");
		await workspaceRows(b.page).getByRole("button", { name, exact: true }).click();
		await expect(b.page).toHaveURL(workspaceUrl);
		await expect(b.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(about(b.page).getByText("Can ask", { exact: true })).toBeVisible();
		// B can only ask, so B shares and changes nothing.
		await expect(b.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(b.page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
		// The title is plain text, and the instructions have no editor.
		await expect(b.page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
		await expect(instructionsSection(b.page)).toContainText(marker);
		await expect(instructionsSection(b.page).getByRole("button")).toHaveCount(0);
		// No documents, and nothing to add them with: no Documents.
		await expect(about(b.page).locator('[data-slot="workspace-documents"]')).toHaveCount(0);
		// No chat of B's in it yet: no "Your chats". B can only ask: no setup cards; the workspace's sections are the page.
		await expect(b.page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);
		await expect(setup(b.page)).toHaveCount(0);
		await expect(about(b.page).getByRole("region", { name: "People" })).toBeVisible();

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
		await expect(workspaceRows(c.page).getByRole("button", { name, exact: true })).toHaveCount(0);
		const slug = new URL(workspaceUrl).searchParams.get("w")!;
		expect((await c.page.request.get(`/api/workspaces/${slug}`)).status()).toBe(404);
		expect((await c.page.request.get("/api/workspaces/no-such-workspace")).status()).toBe(404);
	});

	await test.step("4. A cannot open B's chat in the workspace", async () => {
		await a.page.goto(workspaceUrl);
		await expect(about(a.page).getByText(marker)).toBeVisible();
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
		// Remove is the last item of B's role menu, and asks nothing: it is done at once.
		await roleButton(share, b.person.email).click();
		await expect(a.page.getByRole("menuitem")).toHaveText([/^Can ask/, /^Can edit/, "Remove"]);
		await a.page.getByRole("menuitem", { name: "Remove" }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(0);
		await expect(about(a.page).locator('[data-slot="workspace-member"]')).toHaveCount(0);
		await share.getByRole("button", { name: "Done" }).click();
		await expect(share).toHaveCount(0);

		await b.page.goto(`/?t=${chatId}`);
		await expect(b.page.locator('[data-slot="message"][data-role="user"]')).toHaveText(question);
		await expect(chat.reply(b.page)).toContainText(marker);
		await expect(b.page.locator('[data-slot="workspace-access-lost"]')).toContainText("You no longer have access to this chat's workspace.");
		await expect(chat.field(b.page)).toBeDisabled();
		await expect(workspaceRows(b.page).getByRole("button", { name, exact: true })).toHaveCount(0);
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

test("an admin opens a new workspace to everyone from its setup after a confirmation, and a screen reader hears it once Share closes", async ({ page, admin }) => {
	const workspace = await createWorkspace(page, `Rota ${admin.id.slice(0, 6)}`);
	await page.goto(`/?w=${workspace.slug}`);
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	await setup(page).getByRole("button", { name: "Share workspace" }).click();
	const dialog = page.getByRole("dialog", { name: /Share/ });
	await expect(dialog.getByText("Only the people above can open it.")).toBeVisible();

	// Opening asks first, in place; Cancel leaves it as it was.
	await setGeneral(dialog, "Everyone in the organisation");
	await expect(dialog.getByText("Everyone in the organisation sees it in their sidebar and can ask from its sources.")).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog.getByRole("button", { name: "General access: Only people added" })).toBeVisible();
	await setGeneral(dialog, "Everyone in the organisation");
	await dialog.getByRole("button", { name: "Open to everyone" }).click();
	await expect(dialog.getByRole("button", { name: "General access: Everyone in the organisation" })).toBeVisible();
	await expect(dialog.getByText("Everyone can find it and ask. People above with Can edit can also change it.")).toBeVisible();
	// The People step is done under the dialog; the status line waits until it closes.
	await expect(setupCount(page)).toHaveText("1 of 3 done");
	const said = "Shared with everyone in the organisation. 1 of 3 done.";
	await expect(setupStatus(page)).not.toHaveText(said);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(setupStatus(page)).toHaveText(said);
	await expect(page.getByText("Sharing saved")).toHaveCount(0);

	// Back to only the people added, then everyone again: the same words are said again, not left standing unchanged.
	await setupStatus(page).evaluate((status) => {
		const heard: string[] = [];
		Object.assign(window, { heard });
		new MutationObserver(() => status.textContent && heard.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
	});
	await page.locator('[data-slot="chat-header"]').getByRole("button", { name: "Share", exact: true }).click();
	await setGeneral(dialog, "Only people added");
	await expect(dialog.getByText("Everyone not listed above loses access. Their chats stay theirs.")).toBeVisible();
	await dialog.getByRole("button", { name: "Remove their access" }).click();
	await expect(dialog.getByText("Only the people above can open it.")).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	await setup(page).getByRole("button", { name: "Share workspace" }).click();
	await setGeneral(dialog, "Everyone in the organisation");
	await dialog.getByRole("button", { name: "Open to everyone" }).click();
	await expect(setupCount(page)).toHaveText("1 of 3 done");
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toContain(said);
});

test("an admin opens a workspace to everyone and it keeps its editor: everyone else can ask, not edit; the editor shares but can't close it; closing it takes the others out", async ({
	page,
	admin,
	fake,
	db,
	browser,
}) => {
	test.setTimeout(90_000);
	const name = `Company handbook ${admin.id.slice(0, 6)}`;
	const editor = await newPerson(browser, db, fake, "handbook editor");
	const reader = await newPerson(browser, db, fake, "handbook reader");
	const late = await newPerson(browser, db, fake, "handbook late");
	let workspaceUrl = "";

	await test.step("the admin makes it, adds an editor, and opens it to everyone", async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "New workspace" }).click();
		const made = page.getByRole("dialog", { name: "New workspace" });
		await made.getByLabel("Name").fill(name);
		await made.getByLabel("Instructions").fill("Answer from the handbook.");
		// Every workspace starts private, an admin's too: it is opened from Share.
		await expect(made.getByLabel("Who can use it")).toHaveCount(0);
		await made.getByRole("button", { name: "Create workspace" }).click();
		await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
		workspaceUrl = page.url();

		await page.getByRole("button", { name: "Share", exact: true }).click();
		const share = page.getByRole("dialog", { name: `Share “${name}”` });
		await addPerson(share, editor.person.email);
		// Private: a person added starts at Can ask.
		await expect(roleButton(share, editor.person.email)).toHaveText("Can ask");
		await roleButton(share, editor.person.email).click();
		await page.getByRole("menuitem", { name: /^Can edit/ }).click();
		await expect(roleButton(share, editor.person.email)).toHaveText("Can edit");
		await setGeneral(share, "Everyone in the organisation");
		await share.getByRole("button", { name: "Open to everyone" }).click();
		await expect(share.locator('[data-slot="general-access"]')).toContainText("Can ask");
		await share.getByRole("button", { name: "Done" }).click();
		await expect(share).toHaveCount(0);

		// The page's People: everyone first, then the owner, then the editor.
		await expect(about(page).getByRole("region", { name: "People" }).locator("li")).toHaveText([/Everyone in the organisation\s*Can ask/, /You\s*Owner/, /Can edit$/]);
		await expect(workspaceRows(page).locator('[data-slot="sidebar-item"]').filter({ hasText: name }).locator(".lucide-building-2")).toHaveCount(1);
	});

	await test.step("a third person sees it in the sidebar with the building, can ask, and cannot edit or share", async () => {
		await reader.page.goto("/");
		const row = workspaceRows(reader.page).locator('[data-slot="sidebar-item"]').filter({ hasText: name });
		await expect(row.locator(".lucide-building-2")).toHaveCount(1);
		await row.getByRole("button", { name, exact: true }).click();
		await expect(reader.page).toHaveURL(workspaceUrl);
		await expect(about(reader.page).getByText("Everyone in the organisation", { exact: true })).toBeVisible();
		await expect(reader.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(reader.page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
		await expect(setup(reader.page)).toHaveCount(0);
		await expect(instructionsSection(reader.page)).toContainText("Answer from the handbook.");
		const id = (await jsonOf<{ workspace: { id: string } }>(await reader.page.request.get(`/api/workspaces/${new URL(workspaceUrl).searchParams.get("w")}`))).workspace.id;
		expect((await reader.page.request.patch(`/api/workspaces/${id}`, { data: { name: "Mine" } })).status()).toBe(403);
	});

	await test.step("the editor edits it and shares it: a person added while it is open starts at Can edit; General access is text", async () => {
		await editor.page.goto(workspaceUrl);
		await expect(editor.page.getByRole("button", { name: "Share", exact: true })).toBeVisible();
		await editor.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = editor.page.getByRole("dialog", { name: `Share “${name}”` });
		await expect(share.getByRole("button", { name: /^General access/ })).toHaveCount(0);
		await expect(share.getByText("Only an admin can change this.")).toBeVisible();
		await addPerson(share, late.person.email);
		await expect(roleButton(share, late.person.email)).toHaveText("Can edit");
		await roleButton(share, late.person.email).click();
		await editor.page.getByRole("menuitem", { name: /^Can ask/ }).click();
		await expect(roleButton(share, late.person.email)).toHaveText("Can ask");
		await share.getByRole("button", { name: "Done" }).click();
		await expect(about(editor.page).locator('[data-slot="workspace-member"]')).toHaveCount(2);
	});

	await test.step("the admin closes it to everyone after a confirmation: its people stay, the third person loses it", async () => {
		await page.reload();
		await page.getByRole("button", { name: "Share", exact: true }).click();
		const share = page.getByRole("dialog", { name: `Share “${name}”` });
		await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(2);
		await setGeneral(share, "Only people added");
		await expect(share.getByText("Everyone not listed above loses access. Their chats stay theirs.")).toBeVisible();
		await share.getByRole("button", { name: "Remove their access" }).click();
		await expect(share.getByText("Only the people above can open it.")).toBeVisible();
		await share.getByRole("button", { name: "Done" }).click();
		await expect(about(page).getByText("Everyone in the organisation", { exact: true })).toHaveCount(0);

		await reader.page.reload();
		await expect(reader.page.getByText("No workspace here")).toBeVisible();
		await expect(workspaceRows(reader.page).getByRole("button", { name, exact: true })).toHaveCount(0);
		await editor.page.reload();
		await expect(editor.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(workspaceRows(editor.page).locator('[data-slot="sidebar-item"]').filter({ hasText: name }).locator(".lucide-users")).toHaveCount(1);
	});

	await test.step("the editor removes themself after a confirmation: Share closes, and they leave the page", async () => {
		await editor.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = editor.page.getByRole("dialog", { name: `Share “${name}”` });
		await share.getByRole("button", { name: /^What you can do/ }).click();
		await editor.page.getByRole("menuitem", { name: "Remove" }).click();
		const confirm = editor.page.getByRole("dialog", { name: "Remove yourself?" });
		await expect(confirm).toContainText("You will no longer see");
		await confirm.getByRole("button", { name: "Remove" }).click();
		await expect(share).toHaveCount(0);
		await expect(editor.page.getByText(`You left “${name}”`)).toBeVisible();
		await expect(editor.page).not.toHaveURL(/[?&]w=/);
		await expect(workspaceRows(editor.page).getByRole("button", { name, exact: true })).toHaveCount(0);
	});

	for (const other of [editor, reader, late]) await other.context.close();
});

test("a failed change in Share is taken back, and the dialog says why", async ({ page, person, fake, db, browser }) => {
	const other = await newPerson(browser, db, fake, "refused member");
	const name = `Refused ${person.id.slice(0, 6)}`;
	const { slug } = await createWorkspace(page, name);
	await page.route(/\/api\/workspaces\/[^/]+\/members\//, (route) => route.fulfill({ status: 500, json: { error: "Down" } }));
	await page.goto(`/?w=${slug}`);
	await page.getByRole("button", { name: "Share", exact: true }).click();
	const share = page.getByRole("dialog", { name: `Share “${name}”` });
	await addPerson(share, other.person.email);
	await expect(share.locator('[data-slot="share-error"]')).toHaveText(new RegExp(`could not be added\\. Try again\\.$`));
	await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(0);
	await expect(page.getByText("Sharing saved")).toHaveCount(0);
	await other.context.close();
});

test("a new workspace guides its owner: a card for each setup step leaves once it is done, then its sections are the page, until the first chat", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const name = `HR Policies ${tag}`;
	const marker = `Answer from the HR handbook, ref ${tag}.`;
	const question = `How many days of leave do staff get, ${tag}?`;
	const other = await newPerson(browser, db, fake, "joins hr");
	const field = workspacePage.field(page);

	await test.step("A new private workspace shows a card for each of its three steps, none done", async () => {
		await page.goto("/");
		await page.getByRole("button", { name: "New workspace", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "New workspace" });
		await dialog.getByLabel("Name").fill(name);
		await dialog.getByRole("button", { name: "Create workspace" }).click();
		await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(setup(page).getByRole("heading", { name: "Set up this workspace" })).toBeVisible();
		await expect(setupCount(page)).toHaveText("0 of 3 done");
		await expect(setup(page).getByRole("heading", { level: 3 })).toHaveText(["Instructions", "Sources", "People"]);
		// Every toast from here on, to check that none covers the setup as a step is done.
		await page.evaluate(() => {
			const seen: string[] = [];
			Object.assign(window, { toastsSeen: seen });
			new MutationObserver(() => document.querySelectorAll("[data-sonner-toast]").forEach((toast) => seen.push(toast.textContent ?? ""))).observe(document.body, { childList: true, subtree: true });
		});
		await expect(setup(page).getByRole("button")).toHaveText(["Add instructions", "Upload files", "Share workspace"]);
		// The cards add what the sections' empty areas would, so no empty section shows under them.
		await expect(about(page).getByRole("button", { name: "Add instructions" })).toHaveCount(0);
		await expect(about(page).locator('[data-slot="document-upload-area"]')).toHaveCount(0);
		await expect(page.locator('[data-slot="workspace-chats"]')).toHaveCount(0);
	});

	await test.step("Add instructions, from its card with the keyboard: the card leaves, the instructions show below, focus moves to the next card, and a screen reader hears what changed", async () => {
		await setup(page).getByRole("button", { name: "Add instructions" }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Instructions" });
		await dialog.getByRole("textbox", { name: "Instructions" }).fill(`${marker}\nKeep answers short.`);
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(step(page, "instructions")).toHaveCount(0);
		await expect(setupCount(page)).toHaveText("1 of 3 done");
		await expect(instructionsSection(page)).toContainText(marker);
		await expect(setup(page).getByRole("button", { name: "Upload files" })).toBeFocused();
		await expect(setupStatus(page)).toHaveText("Instructions added. 1 of 3 done.");
	});

	await test.step("Upload files, from the Sources card: the card leaves, and the document shows below", async () => {
		const chooser = page.waitForEvent("filechooser");
		await setup(page).getByRole("button", { name: "Upload files" }).click();
		await (await chooser).setFiles(textFile("Leave policy.md", `# Leave policy\n\nStaff get 27 days of paid leave a year, ${tag}.`));
		await expect(step(page, "documents")).toHaveCount(0);
		await expect(setupCount(page)).toHaveText("2 of 3 done");
		await expect(setupStatus(page)).toHaveText("Sources added. 2 of 3 done.");
		// Its button had focus: the one step left takes it.
		await expect(setup(page).getByRole("button", { name: "Share workspace" })).toBeFocused();
		await expect(about(page).locator('[data-slot="workspace-document"]')).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	});

	await test.step("Share, from its card: the last card leaves with the setup, the workspace's sections are the page, and focus goes to the message box", async () => {
		await setup(page).getByRole("button", { name: "Share workspace" }).click();
		const share = page.getByRole("dialog", { name: `Share “${name}”` });
		await addPerson(share, other.person.email);
		// Done under the dialog; said, and focus moved on, once it closes.
		await expect(setup(page)).toHaveCount(0);
		await share.getByRole("button", { name: "Done" }).click();
		await expect(share).toHaveCount(0);
		await expect(setupStatus(page)).toHaveText("People added. Workspace set up.");
		await expect(field).toBeFocused();
		await expect(about(page).getByRole("region")).toHaveText([/^Instructions/, /^Sources/, /^People/]);
		await expect(about(page).locator('[data-slot="workspace-member"]')).toContainText("Can ask");
		// The instructions show once, in their own section.
		await expect(page.getByText(marker)).toHaveCount(1);
		// The setup said each save: no "saved" toast covered it.
		const toasts = await page.evaluate(() => (window as unknown as { toastsSeen: string[] }).toastsSeen.join(" | "));
		expect(toasts).not.toContain("Instructions saved");
		expect(toasts).not.toContain("Sharing saved");
	});

	await test.step("A question in the box opens a chat that follows the instructions", async () => {
		await field.fill(question);
		await field.press("Enter");
		await expect(page).toHaveURL(/[?&]t=/);
		await expect(chat.reply(page)).toContainText(marker);
		await chat.idle(page);
		const [call] = await fake.calls(question);
		expect(call.system).toContain(marker);
	});

	await test.step("Back on the workspace: its chats first, no setup, and the sections' own Upload and Instructions under them", async () => {
		await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name }).click();
		await expect(page.locator('[data-slot="workspace-chats"]')).toContainText("How many days of leave");
		await expect(setup(page)).toHaveCount(0);
		await expect(instructionsSection(page).getByRole("button", { name: "Edit instructions" })).toBeVisible();
		await expect(about(page).locator('[data-slot="workspace-documents"]').getByRole("button", { name: "Upload", exact: true })).toBeVisible();
		const chats = (await page.locator('[data-slot="workspace-chats"]').boundingBox())!;
		expect(chats.y + chats.height).toBeLessThan((await about(page).boundingBox())!.y);
	});

	await test.step("With no setup on the page, saving the instructions says so in a toast", async () => {
		await instructionsSection(page).getByRole("button", { name: "Edit instructions" }).click();
		const dialog = page.getByRole("dialog", { name: "Instructions" });
		await dialog.getByRole("textbox", { name: "Instructions" }).fill(`${marker}\nKeep answers very short.`);
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText("Instructions saved")).toBeVisible();
	});

	await other.context.close();
});

test("once its owner has a chat in it, an empty workspace's sections are setup cards side by side, rows in one column, each opening what its step does", async ({ page, person, db }) => {
	const workspace = await createWorkspace(page, "Empty with chats");
	await addChats(db, person.id, workspace.id, 1);
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`/?w=${workspace.slug}`);
	await expect(page.locator('[data-slot="workspace-chats"]')).toContainText("Question 1");
	await expect(setup(page)).toHaveCount(0);

	const add = about(page).locator('[data-slot="workspace-add-instructions"]');
	const upload = about(page).locator('[data-slot="document-upload-area"]');
	// The section's heading names the card: it has no title of its own, only its line and button.
	await expect(add).toContainText("Tell Ponder how to answer here.");
	await expect(add.getByRole("heading")).toHaveCount(0);
	await expect(upload.getByRole("button", { name: "Upload files" })).toBeVisible();
	const [left, right] = [(await add.boundingBox())!, (await upload.boundingBox())!];
	expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
	expect(right.x).toBeGreaterThan(left.x + left.width);
	await expect(add).toHaveAttribute("data-layout", "card");

	// In one column, as on a phone, they are rows, as the setup's steps are there.
	await page.setViewportSize({ width: 390, height: 900 });
	await expect(add).toHaveAttribute("data-layout", "row");
	await expect(upload).toHaveAttribute("data-layout", "row");
	await expect(add).toContainText("Add instructions");

	await add.getByRole("button", { name: "Add instructions" }).click();
	await expect(page.getByRole("dialog", { name: "Instructions" })).toBeVisible();
});

test("saving instructions while a file still goes up moves focus to the next step that can take it", async ({ page, person }) => {
	const { slug } = await createWorkspace(page, `Slow upload ${person.id.slice(0, 6)}`);
	// The file's upload is held until the test lets it go.
	let release = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	await page.route(
		(url) => /^\/api\/workspaces\/[^/]+\/documents$/.test(url.pathname),
		async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await released;
			await route.fallback();
		},
	);
	await page.goto(`/?w=${slug}`);
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	const chooser = page.waitForEvent("filechooser");
	await setup(page).getByRole("button", { name: "Upload files" }).click();
	await (await chooser).setFiles(textFile("Rota.md", "# Rota\n\nNights rotate every four weeks."));
	await expect(step(page, "documents").getByRole("button")).toBeDisabled();

	await setup(page).getByRole("button", { name: "Add instructions" }).focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Instructions" });
	await dialog.getByRole("textbox", { name: "Instructions" }).fill("Answer from the rota only.");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(setupCount(page)).toHaveText("1 of 3 done");
	// Not the Documents step, whose button waits for the upload: the next one that can take focus.
	await expect(setup(page).getByRole("button", { name: "Share workspace" })).toBeFocused();

	release();
	await expect(setupCount(page)).toHaveText("2 of 3 done");
});

test("files dropped on a workspace page that is still loading are refused, not lost", async ({ page, person }) => {
	const { id, slug } = await createWorkspace(page, `Loading drop ${person.id.slice(0, 6)}`);
	// The person's chats in it are held: the page has the workspace, but cannot show it yet.
	let release = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	await page.route(
		(url) => url.pathname === "/api/threads" && url.searchParams.get("workspace") === id,
		async (route) => {
			await released;
			await route.fallback();
		},
	);
	const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/workspaces/${slug}`);
	await page.goto(`/?w=${slug}`);
	await loaded;

	const outcome = await page.locator('[data-slot="workspace-view"]').evaluate((view) => {
		const data = new DataTransfer();
		data.items.add(new File(["# Rota"], "Rota.md", { type: "text/markdown" }));
		const over = view.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
		return { handled: !over, effect: data.dropEffect };
	});
	// Handled, so the browser does not open the file, and refused: nothing can take it yet.
	expect(outcome).toEqual({ handled: true, effect: "none" });

	release();
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	await expect(about(page).locator('[data-slot="workspace-document"]')).toHaveCount(0);
});

test("a new workspace keeps what is set up while it still loads, and a refused file's reason stays once the last card leaves", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const name = `Rota rules ${tag}`;
	const other = await newPerson(browser, db, fake, "joins rota");

	await test.step("A document uploaded before the workspace's first answer comes stays when that older answer comes", async () => {
		// The workspace's first read is answered with what the server had then, but only once the test lets it go.
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		let armed = true;
		await page.route(
			(url) => /^\/api\/workspaces\/[^/]+$/.test(url.pathname),
			async (route) => {
				if (!armed || route.request().method() !== "GET") return route.fallback();
				armed = false;
				const response = await route.fetch();
				await released;
				await route.fulfill({ response });
			},
		);
		await page.goto("/");
		await page.getByRole("button", { name: "New workspace", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "New workspace" });
		await dialog.getByLabel("Name").fill(name);
		await dialog.getByRole("button", { name: "Create workspace" }).click();
		await expect(setupCount(page)).toHaveText("0 of 3 done");
		await expect.poll(() => armed).toBe(false);

		const chooser = page.waitForEvent("filechooser");
		await setup(page).getByRole("button", { name: "Upload files" }).click();
		await (await chooser).setFiles(textFile("Rota.md", `# Rota\n\nNights rotate every four weeks, ${tag}.`));
		await expect(step(page, "documents")).toHaveCount(0);
		await expect(setupCount(page)).toHaveText("1 of 3 done");

		release();
		for (let elapsed = 0; elapsed < 2500; elapsed += 100) {
			expect(await step(page, "documents").count(), "the documents card after the older answer").toBe(0);
			await page.waitForTimeout(100);
		}
		await expect(about(page).locator('[data-slot="workspace-document"]')).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		await page.unroute((url) => /^\/api\/workspaces\/[^/]+$/.test(url.pathname));
	});

	await test.step("With the last step done by files dropped on its card, a file the server refused still says why after the card left", async () => {
		await page.getByRole("button", { name: "New workspace", exact: true }).click();
		const made = page.getByRole("dialog", { name: "New workspace" });
		await made.getByLabel("Name").fill(`${name} b`);
		await made.getByRole("button", { name: "Create workspace" }).click();
		await expect(setupCount(page)).toHaveText("0 of 3 done");
		await setup(page).getByRole("button", { name: "Add instructions" }).click();
		const instructions = page.getByRole("dialog", { name: "Instructions" });
		await instructions.getByRole("textbox", { name: "Instructions" }).fill("Answer from the rota only.");
		await instructions.getByRole("button", { name: "Save" }).click();
		await expect(instructions).toHaveCount(0);
		await setup(page).getByRole("button", { name: "Share workspace" }).click();
		const share = page.getByRole("dialog", { name: `Share “${name} b”` });
		await addPerson(share, other.person.email);
		await share.getByRole("button", { name: "Done" }).click();
		await expect(share).toHaveCount(0);
		await expect(setupCount(page)).toHaveText("2 of 3 done");

		// Dragged over the cards, the Documents card says it takes them. One file the server takes,
		// which does the last step, and one it refuses.
		const handover = { name: "Handover.md", type: "text/markdown", text: `# Handover\n\nHand over at seven, ${tag}.` };
		await dropFiles(step(page, "documents"), "dragenter", [handover]);
		await expect(step(page, "documents").locator('[data-slot="document-drop"]')).toBeVisible();
		await expect(step(page, "documents")).toContainText("Drop to upload");
		await dropFiles(step(page, "documents"), "drop", [handover, { name: "tool.exe", type: "application/x-msdownload", text: "MZ not a document" }]);
		await expect(about(page).locator('[data-slot="workspace-document"]')).toHaveCount(1);
		await expect(setup(page)).toHaveCount(0);
		const refused = page.locator('[data-slot="document-upload-errors"]');
		await expect(refused).toBeVisible();
		await page.waitForTimeout(1500);
		await expect(refused).toBeVisible();
		await expect(refused).not.toBeEmpty();
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
		await expect(workspaceRows(page).getByRole("button", { name: renamed, exact: true })).toBeVisible();
		await expect(workspaceRows(page).getByRole("button", { name, exact: true })).toHaveCount(0);
		await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(slug)}$`));
		await page.reload();
		await expect(page.getByRole("heading", { name: renamed, level: 1 })).toBeVisible();
	});

	await test.step("Add instructions opens the Markdown editor; the saved instructions show as Markdown, and their box opens them again", async () => {
		const dialog = page.getByRole("dialog", { name: "Instructions" });
		const editor = dialog.getByRole("textbox", { name: "Instructions" });
		const save = dialog.getByRole("button", { name: "Save" });
		const box = instructionsSection(page).getByRole("button", { name: "Edit instructions" });
		// No chat here yet: the page has no empty Instructions; the setup card adds them.
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

test("the message box floats at the bottom of a workspace page's column, where the chat's box will be; a question there, with a skill, opens its chat", async ({ page, admin, db, fake }) => {
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

	await test.step("Scrolled to the end, the box is in view, on the column's edges, and the last chat can be clicked", async () => {
		await workspacePage.scrollToEnd(page);
		await expect(box).toBeInViewport({ ratio: 1 });
		const boxRect = (await box.boundingBox())!;
		const aboutRect = (await about(page).boundingBox())!;
		expect(Math.abs(boxRect.x - aboutRect.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(boxRect.x + boxRect.width - (aboutRect.x + aboutRect.width))).toBeLessThanOrEqual(1);
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
		const pageBox = (await box.boundingBox())!;
		await workspacePage.field(page).fill(question);
		await workspacePage.field(page).press("Enter");
		await expect(page).toHaveURL(/[?&]t=/);
		await expect(page.locator('[data-slot="message"][data-role="user"]')).toContainText(question);
		await expect(page.locator('[data-slot="message"][data-role="user"] [data-slot="skill-chip"]')).toHaveCount(1);
		await expect(page.locator('[data-slot="chat-breadcrumb"]')).toContainText(name);
		await expect(chat.reply(page)).toContainText(question);
		await chat.idle(page);
		expect(await page.evaluate(() => (window as unknown as { seen: { greeting: boolean } }).seen.greeting)).toBe(false);
		// The chat's box takes the page's box's place, across the same column.
		const chatBox = (await page.locator('[data-slot="prompt-input"]').boundingBox())!;
		expect(Math.abs(chatBox.x - pageBox.x)).toBeLessThanOrEqual(2);
		expect(Math.abs(chatBox.width - pageBox.width)).toBeLessThanOrEqual(2);
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

test("files dropped on the blank page under a new workspace's setup go up as its documents, and the app stays open", async ({ page, person }) => {
	const name = `Blank drop ${person.id.slice(0, 6)}`;
	const { slug } = await createWorkspace(page, name);
	await page.goto(`/?w=${slug}`);
	await expect(setupCount(page)).toHaveText("0 of 3 done");

	// Dropped on the page itself, away from the cards, the sections and the message box.
	const handled = await page.locator('[data-slot="workspace-view"]').evaluate((view) => {
		const data = new DataTransfer();
		data.items.add(new File(["# Rota\n\nNights rotate every four weeks."], "Rota.md", { type: "text/markdown" }));
		const over = view.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
		const drop = view.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
		// dispatchEvent is false when the page handled the event: the browser does not open the file.
		return { over: !over, drop: !drop };
	});
	expect(handled).toEqual({ over: true, drop: true });
	await expect(setupCount(page)).toHaveText("1 of 3 done");
	// One step done, the Documents one: the progress fills from the left.
	const segments = setup(page).locator('[data-slot="workspace-setup-progress"] > *');
	await expect(segments.nth(0)).toHaveAttribute("data-filled", "true");
	await expect(segments.nth(1)).not.toHaveAttribute("data-filled");
	await expect(segments.nth(2)).not.toHaveAttribute("data-filled");
	await expect(about(page).locator('[data-slot="workspace-document"]')).toHaveCount(1);
	await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(slug)}$`));
});

test("an older link by a workspace's id opens it, with the slug in its place", async ({ page, person }) => {
	const name = `Old link ${person.id.slice(0, 6)}`;
	const { id, slug } = await createWorkspace(page, name);
	await page.goto(`/?w=${id}`);
	await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(slug)}$`));
	await expect(workspaceRows(page).locator('[data-state="active"]')).toHaveText(name);
});

test.describe("switching workspaces", () => {
	/** Holds the workspace's own answer and its chats list until the test lets go. */
	async function hold(page: Page, workspace: { id: string; slug: string }) {
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		const own = new RegExp(`/api/workspaces/(${workspace.id}|${escape(workspace.slug)})$`);
		const held = (url: URL) => own.test(url.pathname) || (url.pathname === "/api/threads" && url.searchParams.get("workspace") === workspace.id);
		await page.route(held, async (route) => {
			await released;
			await route.continue();
		});
		return release;
	}

	test("a workspace opened before shows at once while the server is asked, then takes the server's newer copy", async ({ page, person, db }) => {
		const tag = person.id.slice(0, 6);
		const [first, second] = [`Switch alpha ${tag}`, `Switch bravo ${tag}`];
		const a = await createWorkspace(page, first, `Alpha rule one ${tag}.`);
		await uploadReady(page, a.id, textFile("Alpha rota.md", "# Rota\n\nNights rotate."));
		await addChats(db, person.id, a.id, 2);
		await createWorkspace(page, second);

		await page.goto(`/?w=${a.slug}`);
		await expect(instructionsSection(page)).toContainText(`Alpha rule one ${tag}.`);
		await workspaceRows(page).getByRole("button", { name: second, exact: true }).click();
		await expect(page.getByRole("heading", { name: second, level: 1 })).toBeVisible();

		// Meanwhile, elsewhere, the instructions change.
		expect((await page.request.patch(`/api/workspaces/${a.id}`, { data: { instructions: `Alpha rule two ${tag}.` } })).ok()).toBe(true);
		const release = await hold(page, a);
		await workspaceRows(page).getByRole("button", { name: first, exact: true }).click();

		await test.step("its instructions, sources and chats show while the server has not answered", async () => {
			await expect(page.getByRole("heading", { name: first, level: 1 })).toBeVisible();
			await expect(instructionsSection(page)).toContainText(`Alpha rule one ${tag}.`);
			await expect(about(page).locator('[data-slot="workspace-document"]')).toContainText("Alpha rota.md");
			for (const title of ["Question 1", "Question 2"]) await expect(page.locator('[data-slot="workspace-chats"]')).toContainText(title);
			await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
		});

		await test.step("the server's answer replaces it in place", async () => {
			release();
			await expect(instructionsSection(page)).toContainText(`Alpha rule two ${tag}.`);
			await expect(instructionsSection(page)).not.toContainText(`Alpha rule one ${tag}.`);
			await expect(about(page).locator('[data-slot="workspace-document"]')).toContainText("Alpha rota.md");
		});
	});

	test("a chat deleted while an older list of the workspace's chats is on its way does not come back", async ({ page, person, db }) => {
		const tag = person.id.slice(0, 6);
		const a = await createWorkspace(page, `Stale chats ${tag}`);
		await addChats(db, person.id, a.id, 2);
		await page.goto(`/?w=${a.slug}`);
		const chats = page.locator('[data-slot="workspace-chats"]');
		await expect(chats).toContainText("Question 1");
		await expect(chats).toContainText("Question 2");

		// The next read of the workspace's chats is taken now, and answered only when the test lets go.
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		let held = false;
		const isList = (url: URL) => url.pathname === "/api/threads" && url.searchParams.get("workspace") === a.id;
		await page.route(isList, async (route) => {
			if (held) return route.fallback();
			held = true;
			const response = await route.fetch();
			await released;
			await route.fulfill({ response });
		});
		const thread = (title: string) => page.locator('[data-slot="thread-list"] [data-slot="sidebar-item"]').filter({ hasText: title });
		const menuOf = async (title: string, item: "Rename" | "Delete") => {
			await thread(title).hover();
			await thread(title).getByRole("button", { name: `Actions for ${title}` }).click();
			await page.getByRole("menuitem", { name: item }).click();
		};

		// A rename reads the person's chats again, and so the workspace's: that read is held, with both chats in it.
		await menuOf("Question 2", "Rename");
		const rename = page.getByRole("dialog", { name: "Rename thread" });
		await rename.getByRole("textbox", { name: /^Name/ }).fill(`Renamed ${tag}`);
		await rename.getByRole("button", { name: "Rename" }).click();
		await expect(chats).toContainText(`Renamed ${tag}`);
		await expect.poll(() => held).toBe(true);

		await menuOf("Question 1", "Delete");
		await page.getByRole("dialog", { name: "Delete this thread?" }).getByRole("button", { name: "Delete" }).click();
		await expect(chats).not.toContainText("Question 1");

		const answered = page.waitForResponse((response) => isList(new URL(response.url())));
		release();
		await answered;
		// The older answer has had its chance to land.
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 300))));
		await expect(chats).not.toContainText("Question 1");
		await expect(chats).toContainText(`Renamed ${tag}`);
	});

	test("a workspace deleted elsewhere is not found when opened again, and does not show from memory after", async ({ page, person }) => {
		const tag = person.id.slice(0, 6);
		const [first, second] = [`Gone alpha ${tag}`, `Gone bravo ${tag}`];
		const a = await createWorkspace(page, first, `Gone rule ${tag}.`);
		await createWorkspace(page, second);
		await page.goto(`/?w=${a.slug}`);
		await expect(instructionsSection(page)).toContainText(`Gone rule ${tag}.`);
		await workspaceRows(page).getByRole("button", { name: second, exact: true }).click();
		await expect(page.getByRole("heading", { name: second, level: 1 })).toBeVisible();

		expect((await page.request.delete(`/api/workspaces/${a.id}`)).ok()).toBe(true);
		// Its row is still in this tab's sidebar, until the page learns it is gone.
		await workspaceRows(page).getByRole("button", { name: first, exact: true }).click();
		await expect(page.getByText("No workspace here")).toBeVisible();
		await expect(instructionsSection(page)).toHaveCount(0);
		await expect(workspaceRows(page).getByRole("button", { name: first, exact: true })).toHaveCount(0);

		// Back to it by Back and Forward: it is asked for, not shown from memory.
		await workspaceRows(page).getByRole("button", { name: second, exact: true }).click();
		await expect(page.getByRole("heading", { name: second, level: 1 })).toBeVisible();
		const release = await hold(page, a);
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`[?&]w=${escape(a.slug)}$`));
		await expect(page.locator('[data-slot="workspace-view"] [aria-busy="true"]')).toBeVisible();
		await expect(instructionsSection(page)).toHaveCount(0);
		release();
		await expect(page.getByText("No workspace here")).toBeVisible();
	});
});

test("the newest workspace is first in the sidebar; a person pins one from its row's menu to the top, where it stays, and unpins it back to its place", async ({ page, person }) => {
	const tag = person.id.slice(0, 6);
	const [oldest, middle, newest] = ["Pin rota", "Pin minutes", "Pin budget"].map((name) => `${name} ${tag}`);
	for (const name of [oldest, middle, newest]) await createWorkspace(page, name);
	// Workspaces open to everyone, made by other tests at the same time, may sit between this person's own.
	const names = () => workspaceRows(page).locator('[data-slot="sidebar-item"]').allInnerTexts();
	const mine = async () => (await names()).filter((name) => name.endsWith(tag));
	const row = (name: string) => rowOf(page, name);
	const menuButton = (name: string) => row(name).getByRole("button", { name: `Actions for “${name}”` });

	await page.goto("/");
	await expect.poll(mine).toEqual([newest, middle, oldest]);

	await test.step("the row's menu shows on hover, and opening it does not open the workspace", async () => {
		await expect(menuButton(oldest)).toHaveCSS("opacity", "0");
		await row(oldest).hover();
		await expect(menuButton(oldest)).toHaveCSS("opacity", "1");
		await menuButton(oldest).click();
		await expect(page.getByRole("menuitem")).toHaveText(["Pin"]);
		await expect(page).not.toHaveURL(/[?&]w=/);
	});

	await test.step("Pin moves it to the top, above every workspace, marked pinned, and it stays there after a reload", async () => {
		await expect(row(oldest).locator('[data-slot="workspace-pin"]')).toHaveCount(0);
		await page.getByRole("menuitem", { name: "Pin" }).click();
		await expect.poll(async () => (await names())[0]).toBe(oldest);
		await expect.poll(mine).toEqual([oldest, newest, middle]);
		await expectPinned(page, oldest, true);
		await expectPinned(page, newest, false);
		await page.reload();
		await expect.poll(async () => (await names())[0]).toBe(oldest);
		await expect.poll(mine).toEqual([oldest, newest, middle]);
		await expectPinned(page, oldest, true);
	});

	await test.step("Unpin puts it back in the order the workspaces were made", async () => {
		await row(oldest).hover();
		await menuButton(oldest).click();
		await expect(page.getByRole("menuitem")).toHaveText(["Unpin"]);
		await page.getByRole("menuitem", { name: "Unpin" }).click();
		await expect.poll(mine).toEqual([newest, middle, oldest]);
		await expectPinned(page, oldest, false);
		await page.reload();
		await expect.poll(mine).toEqual([newest, middle, oldest]);
		await expectPinned(page, oldest, false);
	});

	await test.step("a row's main click still opens the workspace", async () => {
		await workspaceRows(page).getByRole("button", { name: middle, exact: true }).click();
		await expect(page.getByRole("heading", { name: middle, level: 1 })).toBeVisible();
		await expect(workspaceRows(page).locator('[data-state="active"]')).toHaveText(middle);
	});
});

test("a failed pin puts the row back where it was, and says so", async ({ page, person }) => {
	const tag = person.id.slice(0, 6);
	const [older, newer] = [`Pin fails old ${tag}`, `Pin fails new ${tag}`];
	await createWorkspace(page, older);
	await createWorkspace(page, newer);
	const mine = async () => (await workspaceRows(page).locator('[data-slot="sidebar-item"]').allInnerTexts()).filter((name) => name.endsWith(tag));
	await page.route(/\/api\/workspaces\/[^/]+\/pin$/, (route) => route.fulfill({ status: 500, json: { error: "Down" } }));
	await page.goto("/");
	await expect.poll(mine).toEqual([newer, older]);
	const row = workspaceRows(page).locator('[data-slot="sidebar-item"]').filter({ has: page.getByRole("button", { name: older, exact: true }) });
	await row.hover();
	await row.getByRole("button", { name: `Actions for “${older}”` }).click();
	await page.getByRole("menuitem", { name: "Pin" }).click();
	await expect(page.getByText("The workspace could not be pinned.")).toBeVisible();
	await expect.poll(mine).toEqual([newer, older]);
});

test.describe("pins that race", () => {
	const PIN = /\/api\/workspaces\/[^/]+\/pin$/;
	const pinAnswer = (page: Page, method: "PUT" | "DELETE") => page.waitForResponse((response) => PIN.test(response.url()) && response.request().method() === method);
	/** A promise the test lets go of later. */
	const gate = () => {
		let open = () => {};
		const closed = new Promise<void>((resolve) => (open = resolve));
		return { closed, open };
	};

	test("Pin, then Unpin before the pin is saved: the server ends unpinned, as the row shows", async ({ page, person }) => {
		const tag = person.id.slice(0, 6);
		const [older, newer] = [`Pin twice old ${tag}`, `Pin twice new ${tag}`];
		const { id } = await createWorkspace(page, older);
		await createWorkspace(page, newer);
		const put = gate();
		// The pin is slow to reach the server; the unpin is not.
		await page.route(PIN, async (route) => {
			if (route.request().method() === "PUT") await put.closed;
			await route.continue();
		});
		await page.goto("/");
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		const pinned = pinAnswer(page, "PUT");
		const unpinned = pinAnswer(page, "DELETE");
		await chooseFromMenu(page, older, "Pin");
		await expect.poll(() => mine(page, tag)).toEqual([older, newer]);
		await chooseFromMenu(page, older, "Unpin");
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		put.open();
		await Promise.all([pinned, unpinned]);
		const listed = await jsonOf<{ workspaces: { id: string; pinned: boolean }[] }>(await page.request.get("/api/workspaces"));
		expect(listed.workspaces.find((workspace) => workspace.id === id)?.pinned).toBe(false);
		await page.reload();
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
	});

	test("Pin, then Unpin, and both refused in turn: the row stays where it was, with no toast for the older choice", async ({ page, person }) => {
		const tag = person.id.slice(0, 6);
		const [older, newer] = [`Pin refused old ${tag}`, `Pin refused new ${tag}`];
		await createWorkspace(page, older);
		await createWorkspace(page, newer);
		const [put, remove] = [gate(), gate()];
		await page.route(PIN, async (route) => {
			await (route.request().method() === "PUT" ? put.closed : remove.closed);
			await route.fulfill({ status: 500, json: { error: "Down" } });
		});
		await page.goto("/");
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		const refused = pinAnswer(page, "PUT");
		await chooseFromMenu(page, older, "Pin");
		await chooseFromMenu(page, older, "Unpin");
		put.open();
		await refused;
		remove.open();
		// An unpin sent at once would be refused now; the one choice left is the person's last, which the row shows.
		await page.waitForTimeout(300);
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		await expect(page.getByText("The workspace could not be pinned.")).toHaveCount(0);
	});

	test("a list asked for before a pin, and answered after it, does not take the pin back", async ({ page, person }) => {
		const tag = person.id.slice(0, 6);
		const [older, newer] = [`Pin stale old ${tag}`, `Pin stale new ${tag}`];
		await createWorkspace(page, older);
		await createWorkspace(page, newer);
		const list = gate();
		let asked = () => {};
		const listAsked = new Promise<void>((resolve) => (asked = resolve));
		// The list the page asks for again is read from the server at once, and answered only later.
		await page.route(
			(url) => url.pathname === "/api/workspaces",
			async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				const response = await route.fetch();
				asked();
				await list.closed;
				await route.fulfill({ response });
			},
		);
		// A workspace that is not there: its page asks for the list again (WorkspacePage.vue).
		await page.goto(`/?w=no-such-${tag}`);
		await expect(page.getByText("No workspace here")).toBeVisible();
		await listAsked;
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		const saved = pinAnswer(page, "PUT");
		await chooseFromMenu(page, older, "Pin");
		expect((await saved).ok()).toBe(true);
		const answered = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/workspaces" && response.request().method() === "GET");
		list.open();
		await answered;
		await page.waitForTimeout(300);
		await expect.poll(() => mine(page, tag)).toEqual([older, newer]);
	});

	test("two workspaces made in the same millisecond keep the server's order when another is pinned", async ({ page, person, db }) => {
		const tag = person.id.slice(0, 6);
		const names = [`Pin tie a ${tag}`, `Pin tie b ${tag}`, `Pin tie other ${tag}`];
		const made = [];
		for (const name of names) made.push({ name, ...(await createWorkspace(page, name)) });
		// The one with the smaller id is made later, in the same millisecond: by id alone it would come second.
		const [first, second] = [made[0]!, made[1]!].sort((a, b) => (a.id < b.id ? -1 : 1));
		await db`update workspaces set created_at = '2026-01-01T00:00:00.000200Z' where id = ${first.id}`;
		await db`update workspaces set created_at = '2026-01-01T00:00:00.000100Z' where id = ${second.id}`;
		await page.goto("/");
		const ties = async () => (await mine(page, tag)).filter((name) => name !== names[2]);
		await expect.poll(ties).toEqual([first.name, second.name]);
		await chooseFromMenu(page, names[2]!, "Pin");
		await expect.poll(() => mine(page, tag)).toEqual([names[2], first.name, second.name]);
	});

	test("pinned here, unpinned in another tab: once this tab's list shows it unpinned, Pin is sent again", async ({ page, person, context }) => {
		const tag = person.id.slice(0, 6);
		const [older, newer] = [`Pin tabs old ${tag}`, `Pin tabs new ${tag}`];
		const { id } = await createWorkspace(page, older);
		await createWorkspace(page, newer);
		await page.goto("/");
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		const pinned = pinAnswer(page, "PUT");
		await chooseFromMenu(page, older, "Pin");
		expect((await pinned).ok()).toBe(true);
		await expect.poll(() => mine(page, tag)).toEqual([older, newer]);

		const other = await context.newPage();
		await other.goto("/");
		await expect.poll(() => mine(other, tag)).toEqual([older, newer]);
		const unpinned = pinAnswer(other, "DELETE");
		await chooseFromMenu(other, older, "Unpin");
		expect((await unpinned).ok()).toBe(true);
		await other.close();

		// This tab reads its list again when it makes a workspace.
		await page.getByRole("button", { name: "New workspace" }).click();
		const dialog = page.getByRole("dialog", { name: "New workspace" });
		await dialog.getByLabel("Name").fill(`Pin tabs newest ${tag}`);
		await dialog.getByRole("button", { name: "Create workspace" }).click();
		await expect.poll(() => mine(page, tag)).toEqual([`Pin tabs newest ${tag}`, newer, older]);
		await expectPinned(page, older, false);

		const pinnedAgain = pinAnswer(page, "PUT");
		await chooseFromMenu(page, older, "Pin");
		expect((await pinnedAgain).ok()).toBe(true);
		const listed = await jsonOf<{ workspaces: { id: string; pinned: boolean }[] }>(await page.request.get("/api/workspaces"));
		expect(listed.workspaces.find((workspace) => workspace.id === id)?.pinned).toBe(true);
	});

	test("a person pins a workspace with the keyboard alone", async ({ page, person }) => {
		const tag = person.id.slice(0, 6);
		const [older, newer] = [`Pin keys old ${tag}`, `Pin keys new ${tag}`];
		await createWorkspace(page, older);
		await createWorkspace(page, newer);
		await page.goto("/");
		await expect.poll(() => mine(page, tag)).toEqual([newer, older]);
		await workspaceRows(page).getByRole("button", { name: older, exact: true }).focus();
		await page.keyboard.press("Tab");
		const menuButton = page.getByRole("button", { name: `Actions for “${older}”` });
		await expect(menuButton).toBeFocused();
		await expect(menuButton).toHaveCSS("opacity", "1");
		await page.keyboard.press("Enter");
		await expect(page.getByRole("menuitem", { name: "Pin" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect.poll(() => mine(page, tag)).toEqual([older, newer]);
		await page.reload();
		await expect.poll(() => mine(page, tag)).toEqual([older, newer]);
	});
});

/** This person's workspaces in the sidebar, by the tag their names end with: tests running at once add others. */
async function mine(page: Page, tag: string) {
	return (await workspaceRows(page).locator('[data-slot="sidebar-item"]').allInnerTexts()).filter((name) => name.endsWith(tag));
}

/** A workspace's row in the sidebar, by its name: a pinned row's button says so after it. */
function rowOf(page: Page, name: string) {
	return workspaceRows(page).locator('[data-slot="sidebar-item"]').filter({ has: page.getByRole("button", { name: new RegExp(`^${escape(name)}(, pinned)?$`) }) });
}

/** The row shows a pin after the name, and its name says "pinned", or neither. */
async function expectPinned(page: Page, name: string, pinned: boolean) {
	const row = rowOf(page, name);
	await expect(row.getByRole("button", { name: pinned ? `${name}, pinned` : name, exact: true })).toBeVisible();
	if (pinned) await expect(row.locator('[data-slot="workspace-pin"]')).toBeVisible();
	else await expect(row.locator('[data-slot="workspace-pin"]')).toHaveCount(0);
}

/** Opens a sidebar row's menu with the pointer, and chooses an item. */
async function chooseFromMenu(page: Page, name: string, item: "Pin" | "Unpin") {
	const row = rowOf(page, name);
	await row.hover();
	await row.getByRole("button", { name: `Actions for “${name}”` }).click();
	await page.getByRole("menuitem", { name: item }).click();
}

/** Adds a person in Share by their email: they are added at once. */
async function addPerson(share: Locator, email: string) {
	await share.getByRole("combobox", { name: "Add people or teams" }).fill(email);
	await share.page().getByRole("option", { name: new RegExp(escape(email)) }).click();
}

/** A member's role menu in Share, by their email. */
const roleButton = (share: Locator, email: string) => share.locator('[data-slot="workspace-member"]').filter({ hasText: email }).getByRole("button", { name: /^What / });

/** Chooses General access in Share; opening or closing it then asks to confirm. */
async function setGeneral(share: Locator, label: "Only people added" | "Everyone in the organisation") {
	await share.getByRole("button", { name: /^General access/ }).click();
	await share.page().getByRole("menuitem", { name: label }).click();
}

const workspaceRows = (page: Page) => page.locator('[data-slot="workspace-rows"]');
const about = (page: Page) => page.locator('[data-slot="workspace-about"]');
const instructionsSection = (page: Page) => about(page).getByRole("region", { name: "Instructions" });
const setup = (page: Page) => page.locator('[data-slot="workspace-setup"]');
const setupCount = (page: Page) => page.locator('[data-slot="workspace-setup-count"]');
const setupStatus = (page: Page) => page.locator('[data-slot="workspace-setup-status"]');
// A step that is leaving is inert, for the moment it fades out.
const step = (page: Page, key: "instructions" | "documents" | "people") => page.locator(`[data-slot="workspace-setup-step"][data-step="${key}"]:not([inert])`);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drags files over an element (dragenter), or drops them on it. */
async function dropFiles(target: Locator, type: "dragenter" | "drop", files: { name: string; type: string; text: string }[]) {
	await target.evaluate(
		(element, { type, files }) => {
			const data = new DataTransfer();
			for (const file of files) data.items.add(new File([file.text], file.name, { type: file.type }));
			const events = type === "drop" ? ["dragover", "drop"] : ["dragenter", "dragover"];
			for (const name of events) element.dispatchEvent(new DragEvent(name, { dataTransfer: data, bubbles: true, cancelable: true }));
		},
		{ type, files },
	);
}
