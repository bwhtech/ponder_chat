import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { expect, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";

/**
 * /admin/workspaces and the overview's System line (server/workspaces/admin.ts,
 * server/admin/usage.ts). Other tests make workspaces on the same server at the same time,
 * so the private totals are checked for what this test adds, not for exact numbers.
 */
const headers = { Origin: e2e.baseUrl };

async function createWorkspace(request: APIRequestContext, kind: "org" | "private", name: string) {
	const created = await request.post("/api/workspaces", { data: { kind, name, description: `About ${name}` }, headers });
	expect(created.status(), await created.text()).toBe(201);
	return ((await created.json()) as { workspace: { id: string } }).workspace.id;
}

/** Uploads a Markdown document and waits until it is ready. */
async function addDocument(request: APIRequestContext, workspaceId: string, name: string) {
	const text = `# ${name}\n\nThe night shift hands over at seven. ${"Check each bed before you leave. ".repeat(20)}`;
	const uploaded = await request.post(`/api/workspaces/${workspaceId}/documents`, {
		multipart: { file: { name, mimeType: "text/markdown", buffer: Buffer.from(text) } },
		headers,
	});
	expect(uploaded.status(), await uploaded.text()).toBe(201);
	const id = ((await uploaded.json()) as { document: { id: string } }).document.id;
	await expect
		.poll(async () => {
			const { workspace } = (await (await request.get(`/api/workspaces/${workspaceId}`)).json()) as { workspace: { documents: { id: string; status: string }[] } };
			return workspace.documents.find((document) => document.id === id)?.status;
		}, { timeout: 30_000 })
		.toBe("ready");
	return id;
}

test("an admin sees organisation workspaces with each document's log, and private ones only as totals", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const orgName = `Ward handbook ${mark}`;
	const orgDocument = `handover-${mark}.md`;
	const secret = { workspace: `Saffron diary ${mark}`, document: `tangerine-letters-${mark}.md` };

	const orgId = await createWorkspace(page.request, "org", orgName);
	await addDocument(page.request, orgId, orgDocument);

	// Someone else's private workspace, with a document the admin must never see named.
	const owner = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	const ownerPage = await owner.newPage();
	await signIn(ownerPage, db, fake, uniqueEmail("private owner"));
	const privateId = await createWorkspace(ownerPage.request, "private", secret.workspace);
	await addDocument(ownerPage.request, privateId, secret.document);
	await owner.close();

	const answer = await page.request.get("/api/admin/workspaces");
	expect(answer.ok()).toBe(true);
	const text = await answer.text();
	for (const hidden of [secret.workspace, secret.document, privateId]) expect(text).not.toContain(hidden);
	expect(((await answer.json()) as { private: { workspaces: number } }).private.workspaces).toBeGreaterThanOrEqual(1);

	await page.goto("/admin/workspaces");
	await expect(page.getByRole("heading", { name: "Workspaces", exact: true })).toBeVisible();
	const workspace = page.getByRole("article", { name: orgName });
	await expect(workspace.getByRole("heading", { name: orgName })).toBeVisible();
	// Descriptions are kept, but not shown for now.
	await expect(workspace.getByText(`About ${orgName}`)).toHaveCount(0);
	const row = workspace.locator(`[data-document="${orgDocument}"]`);
	await expect(row).toContainText("Ready");

	await row.click();
	const log = page.getByRole("dialog");
	await expect(log.getByText(orgDocument).first()).toBeVisible();
	await expect(log.locator('[data-step="uploaded"]')).toContainText("Uploaded");
	await expect(log.locator('[data-step="embedded"]')).toContainText("Embedded batch 1");
	await expect(log.locator('[data-step="ready"]')).toContainText("Ready");
	await page.keyboard.press("Escape");
	await expect(log).toHaveCount(0);

	const totals = page.locator('[data-slot="private-workspaces"]');
	await expect(totals.getByText("Private workspaces", { exact: true }).first()).toBeVisible();
	await expect(totals.getByText("Documents ready", { exact: true })).toBeVisible();
	for (const hidden of [secret.workspace, secret.document]) await expect(page.getByText(hidden)).toHaveCount(0);

	// An admin is no one special in a private workspace.
	expect((await page.request.get(`/api/workspaces/${privateId}`)).status()).toBe(404);

	// Making the organisation workspace is in the activity log, by name.
	await page.goto("/admin/activity");
	await expect(page.getByText(`Made the workspace “${orgName}” for everyone`).first()).toBeVisible();
});

test("the page follows a document while it is being read, and so does its open log", async ({ page, admin }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const orgName = `Reading ward ${mark}`;
	const orgDocument = `rota-${mark}.md`;
	const orgId = await createWorkspace(page.request, "org", orgName);
	await addDocument(page.request, orgId, orgDocument);

	// The first answers say the document is still Reading; the later ones say what the server says (Ready).
	let held = 2;
	await page.route("**/api/admin/workspaces", async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { org: { id: string; documents: { status: string }[] }[] };
		if (held > 0) {
			held--;
			for (const document of body.org.find((workspace) => workspace.id === orgId)?.documents ?? []) document.status = "reading";
		}
		await route.fulfill({ response, json: body });
	});

	await page.goto("/admin/workspaces");
	const row = page.getByRole("article", { name: orgName }).locator(`[data-document="${orgDocument}"]`);
	await expect(row).toContainText("Reading");
	await row.click();
	const log = page.getByRole("dialog");
	await expect(log.locator('[data-slot="document-log"] > p').first()).toContainText("Reading");
	// No reload: the page reads the report again, and the row and the open log say Ready.
	await expect(log.locator('[data-slot="document-log"] > p').first()).toContainText("Ready", { timeout: 15_000 });
	await page.keyboard.press("Escape");
	await expect(row).toContainText("Ready");
});

test("a person who is not an admin can't read workspaces through /api/admin", async ({ page, person }) => {
	void person;
	expect((await page.request.get("/api/admin/workspaces")).status()).toBe(403);
	expect((await page.request.get("/api/admin/workspaces/any/documents/any/log")).status()).toBe(403);
});

test("the overview shows the System line, apart from anyone's credits", async ({ page, admin }) => {
	void admin;
	await page.goto("/admin");
	const system = page.locator('[data-slot="system-spend"]');
	await expect(system.getByRole("heading", { name: "System" })).toBeVisible();
	// A tiny spend reads "<$0.0001".
	await expect(system.getByText(/^Last 14 days · <?\$/)).toBeVisible();
	await expect(system.getByText("They are not counted against anyone's credits.", { exact: false })).toBeVisible();
	for (const line of ["Chat names", "Memory", "Workspace documents", "Picture pages", "Workspace search"]) await expect(system.getByText(line, { exact: true })).toBeVisible();

	await page.getByText("30 days", { exact: true }).first().click();
	await expect(system.getByText(/^Last 30 days · <?\$/)).toBeVisible();
});
