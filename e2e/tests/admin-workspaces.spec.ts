import type { APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { expect, jsonOf, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";
import { scanPdf } from "../pdfs.ts";

/**
 * /admin/workspaces and the overview's System line (server/workspaces/admin.ts,
 * server/admin/usage.ts). Other tests make workspaces on the same server at the same time,
 * so the private totals are checked for what this test adds, not for exact numbers.
 */
const headers = { Origin: e2e.baseUrl };

/** A new workspace, private as every workspace starts; "open" opens it to everyone, as an admin does from Share. */
async function createWorkspace(request: APIRequestContext, access: "open" | "private", name: string) {
	const created = await request.post("/api/workspaces", { data: { name, description: `About ${name}` }, headers });
	expect(created.status(), await created.text()).toBe(201);
	const id = (await jsonOf<{ workspace: { id: string } }>(created)).workspace.id;
	if (access === "open") {
		const opened = await request.put(`/api/workspaces/${id}/access`, { data: { orgAccess: "ask" }, headers });
		expect(opened.status(), await opened.text()).toBe(200);
	}
	return id;
}

/** Uploads a document, Markdown unless `file` says otherwise, and waits until it is ready. */
async function addDocument(request: APIRequestContext, workspaceId: string, name: string, file?: { mimeType: string; buffer: Buffer }) {
	const text = `# ${name}\n\nThe night shift hands over at seven. ${"Check each bed before you leave. ".repeat(20)}`;
	const uploaded = await request.post(`/api/workspaces/${workspaceId}/documents`, {
		multipart: { file: { name, ...(file ?? { mimeType: "text/markdown", buffer: Buffer.from(text) }) } },
		headers,
	});
	expect(uploaded.status(), await uploaded.text()).toBe(201);
	const id = (await jsonOf<{ document: { id: string } }>(uploaded)).document.id;
	await expect
		.poll(async () => {
			const { workspace } = await jsonOf<{ workspace: { documents: { id: string; status: string }[] } }>(await request.get(`/api/workspaces/${workspaceId}`));
			return workspace.documents.find((document) => document.id === id)?.status;
		}, { timeout: 30_000 })
		.toBe("ready");
	return id;
}

test("an admin sees workspaces open to everyone with each document's log, and private ones only as totals", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const orgName = `Ward handbook ${mark}`;
	const orgDocument = `handover-${mark}.md`;
	const secret = { workspace: `Saffron diary ${mark}`, document: `tangerine-letters-${mark}.md` };

	const orgId = await createWorkspace(page.request, "open", orgName);
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
	expect((await jsonOf<{ private: { workspaces: number } }>(answer)).private.workspaces).toBeGreaterThanOrEqual(1);

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
	await expect(totals.getByRole("heading", { name: "Private", exact: true })).toBeVisible();
	await expect(totals.getByText("Documents ready", { exact: true })).toBeVisible();
	for (const hidden of [secret.workspace, secret.document]) await expect(page.getByText(hidden)).toHaveCount(0);

	// An admin is no one special in a private workspace.
	expect((await page.request.get(`/api/workspaces/${privateId}`)).status()).toBe(404);

	// Opening it to everyone is in the activity log, by name, with what changed.
	await page.goto("/admin/activity");
	const opened = page.getByText(`Opened the workspace “${orgName}” to everyone`).first();
	await expect(opened).toBeVisible();
	await expect(page.getByText("General access: Only people added → Everyone (can ask)").first()).toBeVisible();
});

test("the page follows a document while it is being read, and so does its open log", async ({ page, admin }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const orgName = `Reading ward ${mark}`;
	const orgDocument = `rota-${mark}.md`;
	const orgId = await createWorkspace(page.request, "open", orgName);
	await addDocument(page.request, orgId, orgDocument);

	// The first answers say the document is still Indexing, with a model on its second page of five; the later ones
	// say what the server says (Ready).
	let held = 2;
	await page.route("**/api/admin/workspaces", async (route) => {
		const response = await route.fetch();
		const body = await jsonOf<{ org: { id: string; documents: { status: string; progress: unknown }[] }[] }>(response);
		if (held > 0) {
			held--;
			for (const document of body.org.find((workspace) => workspace.id === orgId)?.documents ?? []) {
				document.status = "reading";
				document.progress = { phase: "pages", done: 2, total: 5 };
			}
		}
		await route.fulfill({ response, json: body });
	});

	await page.goto("/admin/workspaces");
	const row = page.getByRole("article", { name: orgName }).locator(`[data-document="${orgDocument}"]`);
	// On a wide screen the progress is a line of its own under the status.
	await expect(row.locator('[data-slot="document-status"]')).toHaveText(/^Indexing…\s*page 2 of 5$/);
	await row.click();
	const log = page.getByRole("dialog");
	await expect(log.locator('[data-slot="document-progress"]')).toHaveText("Indexing… page 2 of 5");
	// No reload: the page reads the report again, and the row and the open log say Ready.
	await expect(log.locator('[data-slot="document-log"] > p').first()).toContainText("Ready", { timeout: 15_000 });
	await page.keyboard.press("Escape");
	await expect(row).toContainText("Ready");
});

test("an admin's log shows a PDF's page reads as one row, which opens to each page", async ({ page, admin, fake }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const key = `PAGEKEY-admin-${mark}`;
	await fake.page({ match: key, text: "Exit site care: clean the exit site every second day." });
	const orgName = `Scanned ward ${mark}`;
	const name = `forms-${mark}.pdf`;
	const orgId = await createWorkspace(page.request, "open", orgName);
	// A line of text, then three scans that the page model reads.
	await addDocument(page.request, orgId, name, { mimeType: "application/pdf", buffer: scanPdf("Ward forms", key, 3) });

	await page.goto("/admin/workspaces");
	await page.getByRole("article", { name: orgName }).locator(`[data-document="${name}"]`).click();
	const log = page.getByRole("dialog");
	const group = log.locator('[data-step="page-reads"]');
	const toggle = group.getByRole("button");
	const pages = group.locator('[data-step="page-read"]');
	await expect(toggle).toHaveText(/^3 pages read by \S+/);
	await expect(group).toContainText("Pages 2–4");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(pages).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(pages).toHaveCount(3);
	await expect(pages.first()).toContainText("Page 2 read by a model");
	await toggle.click();
	await expect(pages).toHaveCount(0);
	await expect(log.locator('[data-step="ready"]')).toContainText("Ready");
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
