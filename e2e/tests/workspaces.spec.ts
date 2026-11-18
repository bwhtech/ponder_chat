import type { Locator, Page } from "@playwright/test";
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
		// Not an admin: no choice of who can use it.
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
		// Nothing to save until someone is added.
		await expect(share.getByRole("button", { name: "Save" })).toBeDisabled();
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(b.person.email);
		await a.page.getByRole("option", { name: new RegExp(escape(b.person.email)) }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toContainText(b.person.email);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(about(a.page).locator('[data-slot="workspace-member"]')).toContainText("Can ask");
	});

	await test.step("2. B sees it in the sidebar and asks with its instructions", async () => {
		await b.page.goto("/");
		await workspaceRows(b.page).getByRole("button", { name, exact: true }).click();
		await expect(b.page).toHaveURL(workspaceUrl);
		await expect(b.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(about(b.page).getByText("Can ask", { exact: true })).toBeVisible();
		// Only the owner shares or deletes; B can only ask, so B changes nothing.
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
		await expect(share.getByRole("button", { name: "Save" })).toBeDisabled();
		await share.locator('[data-slot="workspace-member"]').getByRole("button", { name: /^Remove / }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(0);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(about(a.page).locator('[data-slot="workspace-member"]')).toHaveCount(0);

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

test("an admin shares a new private workspace with everyone from its setup, and a screen reader hears it", async ({ page, admin }) => {
	const workspace = await createWorkspace(page, `Rota ${admin.id.slice(0, 6)}`);
	await page.goto(`/?w=${workspace.slug}`);
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	await setup(page).getByRole("button", { name: "Share workspace" }).click();
	const dialog = page.getByRole("dialog", { name: /Share/ });
	await dialog.getByLabel("Who can use it").click();
	await page.getByRole("option", { name: "Everyone in the organisation" }).click();
	await dialog.getByRole("button", { name: "Save" }).click();
	// The People step goes rather than turns done, and no toast covers the setup: the status line says it.
	await expect(setupCount(page)).toHaveText("0 of 2 done");
	const said = "Workspace shared with everyone in the organisation. 0 of 2 done.";
	await expect(setupStatus(page)).toHaveText(said);
	await expect(page.getByText("Sharing saved")).toHaveCount(0);

	// Back to only the people added, then everyone again: the same words are said again, not left standing unchanged.
	await setupStatus(page).evaluate((status) => {
		const heard: string[] = [];
		Object.assign(window, { heard });
		new MutationObserver(() => status.textContent && heard.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
	});
	await page.locator('[data-slot="chat-header"]').getByRole("button", { name: "Share", exact: true }).click();
	await dialog.getByLabel("Who can use it").click();
	await page.getByRole("option", { name: "Only the people you add" }).click();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(setupCount(page)).toHaveText("0 of 3 done");
	await setup(page).getByRole("button", { name: "Share workspace" }).click();
	await dialog.getByLabel("Who can use it").click();
	await page.getByRole("option", { name: "Everyone in the organisation" }).click();
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(setupCount(page)).toHaveText("0 of 2 done");
	await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toContain(said);
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
	await expect(about(page).getByText("Everyone in the organisation", { exact: true })).toBeVisible();
	// Everyone uses it already: it has no People step. The instructions from the dialog are done, so the one card left is Documents.
	await expect(setup(page).getByRole("heading", { name: "Set up this workspace" })).toBeVisible();
	await expect(setupCount(page)).toHaveText("1 of 2 done");
	await expect(setup(page).getByRole("heading", { level: 3 })).toHaveText(["Sources"]);
	await expect(setup(page).getByRole("button", { name: "Share workspace" })).toHaveCount(0);
	const workspaceUrl = page.url();

	for (const title of ["first person", "second person"]) {
		const other = await newPerson(browser, db, fake, title);
		await other.page.goto("/");
		await workspaceRows(other.page).getByRole("button", { name, exact: true }).click();
		await expect(other.page).toHaveURL(workspaceUrl);
		await expect(other.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(about(other.page).getByText("Everyone in the organisation", { exact: true })).toBeVisible();
		// Everyone asks; only admins change it.
		await expect(other.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(other.page.getByRole("button", { name: "Workspace actions" })).toHaveCount(0);
		// Nor do they see its setup cards: its instructions and people are the page.
		await expect(setup(other.page)).toHaveCount(0);
		await expect(instructionsSection(other.page)).toContainText("Answer from the handbook.");
		await other.context.close();
	}
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
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(other.person.email);
		await page.getByRole("option", { name: new RegExp(escape(other.person.email)) }).click();
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(setup(page)).toHaveCount(0);
		await expect(setupStatus(page)).toHaveText("Workspace shared. Workspace set up.");
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
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(other.person.email);
		await page.getByRole("option", { name: new RegExp(escape(other.person.email)) }).click();
		await share.getByRole("button", { name: "Save" }).click();
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

test("the newest workspace is first in the sidebar; a person pins one from its row's menu to the top, where it stays, and unpins it back to its place", async ({ page, person }) => {
	const tag = person.id.slice(0, 6);
	const [oldest, middle, newest] = ["Pin rota", "Pin minutes", "Pin budget"].map((name) => `${name} ${tag}`);
	for (const name of [oldest, middle, newest]) await createWorkspace(page, name);
	// Workspaces for everyone, made by other tests at the same time, may sit between this person's own.
	const names = () => workspaceRows(page).locator('[data-slot="sidebar-item"]').allInnerTexts();
	const mine = async () => (await names()).filter((name) => name.endsWith(tag));
	const row = (name: string) => workspaceRows(page).locator('[data-slot="sidebar-item"]').filter({ has: page.getByRole("button", { name, exact: true }) });
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

	await test.step("Pin moves it to the top, above every workspace, and it stays there after a reload", async () => {
		await page.getByRole("menuitem", { name: "Pin" }).click();
		await expect.poll(async () => (await names())[0]).toBe(oldest);
		await expect.poll(mine).toEqual([oldest, newest, middle]);
		await page.reload();
		await expect.poll(async () => (await names())[0]).toBe(oldest);
		await expect.poll(mine).toEqual([oldest, newest, middle]);
	});

	await test.step("Unpin puts it back in the order the workspaces were made", async () => {
		await row(oldest).hover();
		await menuButton(oldest).click();
		await expect(page.getByRole("menuitem")).toHaveText(["Unpin"]);
		await page.getByRole("menuitem", { name: "Unpin" }).click();
		await expect.poll(mine).toEqual([newest, middle, oldest]);
		await page.reload();
		await expect.poll(mine).toEqual([newest, middle, oldest]);
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
