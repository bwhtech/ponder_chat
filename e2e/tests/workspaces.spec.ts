import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { chat, expect, test } from "../fixtures.ts";
import { createWorkspace, newPerson } from "../workspaces.ts";

/**
 * Workspaces and sharing (docs/workspaces-plan.md, "Tests"): a person makes a workspace with
 * instructions and shares it; the people in it ask with those instructions; nobody else can
 * find it; chats stay their writers' own; and a person who is removed can read their chat
 * but not send in it. An admin's workspace for everyone shows for everyone.
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
		await dialog.getByLabel("Description (optional)").fill("Questions about leave");
		await dialog.getByLabel("Instructions").fill(`${marker}\nKeep answers short.`);
		// Not an admin: no choice of who can use it.
		await expect(dialog.getByLabel("Who can use it")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Create workspace" }).click();

		// The address has the workspace's slug, made from its name.
		await expect(a.page).toHaveURL(/[?&]w=leave-policies-/);
		workspaceUrl = a.page.url();
		await expect(a.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(a.page.getByText("Only you", { exact: true })).toBeVisible();
		await expect(workspaceRows(a.page).getByRole("button", { name })).toBeVisible();
		await expect(aside(a.page).getByText(marker)).toBeVisible();

		await a.page.getByRole("button", { name: "Share", exact: true }).click();
		const share = a.page.getByRole("dialog", { name: `Share “${name}”` });
		await share.getByRole("combobox", { name: "Add people by name or email" }).fill(b.person.email);
		await a.page.getByRole("option", { name: new RegExp(escape(b.person.email)) }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toContainText(b.person.email);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(share).toHaveCount(0);
		await expect(a.page.getByText("You and 1 person", { exact: true })).toBeVisible();
		await expect(aside(a.page).locator('[data-slot="workspace-member"]')).toContainText("Can ask");
	});

	await test.step("2. B sees it in the sidebar and asks with its instructions", async () => {
		await b.page.goto("/");
		await workspaceRows(b.page).getByRole("button", { name }).click();
		await expect(b.page).toHaveURL(workspaceUrl);
		await expect(b.page.getByRole("heading", { name, level: 1 })).toBeVisible();
		await expect(b.page.getByText("Shared with you", { exact: true })).toBeVisible();
		// Only the owner shares or deletes.
		await expect(b.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
		await expect(b.page.getByText("No chats yet.")).toBeVisible();

		await chat.send(b.page, question);
		await expect(b.page).toHaveURL(/[?&]t=/);
		chatId = new URL(b.page.url()).searchParams.get("t")!;
		await expect(chat.reply(b.page)).toContainText(`Workspace “${name}” says: ${marker}`);
		await chat.idle(b.page);
		// The chat is in the workspace: its composer names it, and so does its row in the list.
		await expect(b.page.locator('[data-slot="workspace-chip"]')).toHaveText(name);
		await expect(b.page.locator('[data-slot="thread-workspace"]').first()).toHaveText(name);
		const [call] = await fake.calls(question);
		expect(call.system).toContain(marker);

		// The workspace page lists B's own chat.
		await b.page.goto(workspaceUrl);
		await expect(b.page.locator('[data-slot="workspace-chats"]')).toContainText("How many days of leave");
	});

	await test.step("3. C gets not found for the same address", async () => {
		await c.page.goto(workspaceUrl);
		await expect(c.page.getByText("This workspace was not found")).toBeVisible();
		await expect(c.page.getByText(marker)).toHaveCount(0);
		await expect(workspaceRows(c.page).getByRole("button", { name })).toHaveCount(0);
		const slug = new URL(workspaceUrl).searchParams.get("w")!;
		expect((await c.page.request.get(`/api/workspaces/${slug}`)).status()).toBe(404);
		expect((await c.page.request.get("/api/workspaces/no-such-workspace")).status()).toBe(404);
	});

	await test.step("4. A cannot open B's chat in the workspace", async () => {
		await a.page.goto(workspaceUrl);
		await expect(a.page.getByText("No chats yet.")).toBeVisible();
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
		await share.locator('[data-slot="workspace-member"]').getByRole("button", { name: /^Remove / }).click();
		await expect(share.locator('[data-slot="workspace-member"]')).toHaveCount(0);
		await share.getByRole("button", { name: "Save" }).click();
		await expect(a.page.getByText("Only you", { exact: true })).toBeVisible();

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
	await expect(page.getByText("Everyone", { exact: true })).toBeVisible();
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
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
