import type { Browser, BrowserContext, Page } from "@playwright/test";
import type postgres from "postgres";
import { e2e } from "./env.ts";
import { expect, randomIp, signIn, uniqueEmail, type Fake, type Person } from "./fixtures.ts";

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

/** A private workspace of the page's person; its id. */
export async function createWorkspace(page: Page, name: string, instructions = "") {
	const response = await page.request.post("/api/workspaces", { data: { name, instructions } });
	expect(response.status(), await response.text()).toBe(201);
	return ((await response.json()) as { workspace: { id: string } }).workspace.id;
}

export async function share(page: Page, workspaceId: string, members: { userId: string; access: "ask" | "edit" }[]) {
	const response = await page.request.put(`/api/workspaces/${workspaceId}/sharing`, { data: { kind: "private", members } });
	expect(response.ok(), await response.text()).toBe(true);
}

/** Uploads a document through the API, and waits until it is Ready. Its id. */
export async function uploadReady(page: Page, workspaceId: string, file: Upload) {
	const response = await page.request.post(`/api/workspaces/${workspaceId}/documents`, { multipart: { file } });
	expect(response.status(), await response.text()).toBe(201);
	const { document } = (await response.json()) as { document: DocumentStatus };
	await expect.poll(async () => (await documentOf(page, workspaceId, document.id))?.status, { timeout: 30_000 }).toBe("ready");
	return document.id;
}

/** The document as the workspace lists it, for the page's person, by its id or its name. */
export async function documentOf(page: Page, workspaceId: string, idOrName: string) {
	const { workspace } = (await (await page.request.get(`/api/workspaces/${workspaceId}`)).json()) as { workspace: { documents: DocumentStatus[] } };
	return workspace.documents.find((document) => document.id === idOrName || document.name === idOrName);
}

export function textFile(name: string, text: string, mimeType = "text/markdown"): Upload {
	return { name, mimeType, buffer: Buffer.from(text) };
}
