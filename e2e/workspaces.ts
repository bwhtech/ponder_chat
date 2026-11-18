import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import type postgres from "postgres";
import { e2e } from "./env.ts";
import { expect, jsonOf, randomIp, signIn, uniqueEmail, type Fake, type Person } from "./fixtures.ts";

/**
 * What the workspace tests share (workspaces.spec.ts, workspaces-documents.spec.ts,
 * exfiltration.spec.ts): another person in a browser of their own, and a workspace with
 * documents made through the API, for tests about what happens after.
 */
export type Other = { page: Page; person: Person; context: BrowserContext };
export type Upload = { name: string; mimeType: string; buffer: Buffer };
type DocumentStatus = { id: string; name: string; status: "reading" | "ready" | "failed"; error: string | null };

/** Another person, signed in in a browser of their own. */
export async function newPerson(browser: Browser, db: postgres.Sql, fake: Fake, title: string): Promise<Other> {
	const context = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	const page = await context.newPage();
	const person = await signIn(page, db, fake, uniqueEmail(title));
	return { page, person, context };
}

/** A private workspace of the page's person: its id, for the API, and its slug, for the page's address (`/?w=<slug>`). */
export async function createWorkspace(page: Page, name: string, instructions = "") {
	const response = await page.request.post("/api/workspaces", { data: { name, instructions } });
	expect(response.status(), await response.text()).toBe(201);
	return (await jsonOf<{ workspace: { id: string; slug: string } }>(response)).workspace;
}

/** Adds each person to the workspace, with their role, as Share does: one at a time. */
export async function share(page: Page, workspaceId: string, members: { userId: string; access: "ask" | "edit" }[]) {
	for (const member of members) {
		const response = await page.request.put(`/api/workspaces/${workspaceId}/members/${member.userId}`, { data: { access: member.access } });
		expect(response.ok(), await response.text()).toBe(true);
	}
}

/** Opens the workspace to everyone in the organisation: the page's person must be an admin. */
export async function openToEveryone(page: Page, workspaceId: string) {
	const response = await page.request.put(`/api/workspaces/${workspaceId}/access`, { data: { orgAccess: "ask" } });
	expect(response.ok(), await response.text()).toBe(true);
}

/** Uploads a document through the API, and waits until it is Ready. Its id. */
export async function uploadReady(page: Page, workspaceId: string, file: Upload) {
	const response = await page.request.post(`/api/workspaces/${workspaceId}/documents`, { multipart: { file } });
	expect(response.status(), await response.text()).toBe(201);
	const { document } = await jsonOf<{ document: DocumentStatus }>(response);
	await expect.poll(async () => (await documentOf(page, workspaceId, document.id))?.status, { timeout: 30_000 }).toBe("ready");
	return document.id;
}

/** The document as the workspace lists it, for the page's person, by its id or its name. */
export async function documentOf(page: Page, workspaceId: string, idOrName: string) {
	const { workspace } = await jsonOf<{ workspace: { documents: DocumentStatus[] } }>(await page.request.get(`/api/workspaces/${workspaceId}`));
	return workspace.documents.find((document) => document.id === idOrName || document.name === idOrName);
}

export function textFile(name: string, text: string, mimeType = "text/markdown"): Upload {
	return { name, mimeType, buffer: Buffer.from(text) };
}

/**
 * `count` chats of the person in a workspace, as rows, newest first: a page that needs many
 * chats to scroll gets them without asking each one. Their ids, newest first.
 */
export async function addChats(db: postgres.Sql, ownerId: string, workspaceId: string, count: number) {
	const ids: string[] = [];
	for (let index = 0; index < count; index++) {
		const id = `chat-${workspaceId.slice(0, 8)}-${index}`;
		const messages = [{ id: `${id}-1`, role: "user", parts: [{ type: "text", text: `Question ${index + 1}` }] }];
		await db`insert into threads (id, owner, title, workspace_id, messages, updated_at)
			values (${id}, ${ownerId}, ${`Question ${index + 1}`}, ${workspaceId}, ${db.json(messages)}, now() - make_interval(hours => ${index}))`;
		ids.push(id);
	}
	return ids;
}

/** A skill that is on, which anyone can ask for with $name. The page's person must be an admin. */
export async function createSkill(page: Page, name: string, description: string, body: string) {
	const response = await page.request.post("/api/admin/skills", { data: { name, description, body, enabled: true, automatic: false }, headers: { origin: e2e.baseUrl } });
	expect(response.ok(), await response.text()).toBe(true);
}

/** The workspace page's message box and its field, and the page's scroller. */
export const workspacePage = {
	box: (page: Page) => page.locator('[data-slot="workspace-composer"] [data-slot="prompt-input"]'),
	field: (page: Page) => page.locator('[data-slot="workspace-composer"] textarea'),
	scrollToEnd: (page: Page) => page.locator('[data-slot="workspace-view"]').evaluate((view) => view.scrollTo({ top: view.scrollHeight })),
	/** Nothing covers the middle of the element where it is now: a click there reaches it without scrolling. */
	reachable: (target: Locator) =>
		target.evaluate((element) => {
			const { left, top, width, height } = element.getBoundingClientRect();
			return element.contains(document.elementFromPoint(left + width / 2, top + height / 2));
		}),
};
