import type { Locator, Page } from "@playwright/test";
import type { ReceivedCall } from "../fake/script.ts";
import { chat, expect, jsonOf, test } from "../fixtures.ts";
import { scanPdf, textPdf } from "../pdfs.ts";
import { addChats, createWorkspace, documentOf, newPerson, share, textFile, uploadReady, type Upload } from "../workspaces.ts";

/**
 * Workspace documents (docs/workspaces-plan.md, "Tests", 7 to 9): an editor uploads a document,
 * it goes from Indexing to Ready, and answers use it, whole when it fits the model's window and
 * as searched passages when it does not; a document's Details in the side panel, for editors
 * only, with a summary first and the indexing log behind Log; a document that fails, then
 * reads on "Try again"; a PDF whose pages are counted on its row and in Details while the
 * model reads them, and then shown as one step; and a document opened in the side viewer.
 *
 * The fake model quotes the line of the workspace's text that best matches the question, and
 * says whether it came from a whole document or an excerpt (fake/server.ts). Its embeddings
 * are word counts, so a question is near the passage that shares its words. GLM 5.3 has a
 * 40,000-token window there, so a document of 100,000 characters is searched in its chats.
 * The fake page model reads the scans of the PDFs here (pdfs.ts, scanPdf), and fails as told.
 */
const documents = (page: Page) => page.locator('[data-slot="workspace-documents"]');
const rows = (page: Page) => documents(page).locator('[data-slot="workspace-document"]');
const row = (page: Page, name: string) => rows(page).filter({ has: page.locator('[data-slot="document-name"]', { hasText: name }) });
const picker = (page: Page) => page.locator('[data-slot="document-picker"]');
const dropState = (page: Page) => page.locator('[data-slot="workspace-about"] [data-slot="document-drop"]');

/** Opens a document's Details from its row's menu: they show in the side panel. */
async function openDetails(page: Page, name: string) {
	const menu = row(page, name).getByRole("button", { name: `Actions for “${name}”` });
	await menu.click();
	await page.getByRole("menuitem", { name: "Details" }).click();
	const details = page.getByRole("complementary", { name: `Details of “${name}”` });
	await expect(details).toBeVisible();
	return { details, menu };
}

test("7. an editor uploads documents; they go from Indexing to Ready, and answers use them whole or searched", async ({ page, person, fake, db }) => {
	test.setTimeout(120_000);
	const tag = person.id.slice(0, 6);
	const { id, slug } = await createWorkspace(page, `Office handbook ${tag}`);
	// A chat here already: no setup cards, so the workspace's sections have their own empty areas.
	await addChats(db, person.id, id, 1);
	await page.goto(`/?w=${slug}`);
	await expect(page.locator('[data-slot="workspace-chats"] li')).toHaveCount(1);
	// No documents yet: the section is one "Upload files" area.
	await expect(documents(page).getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
	await expect(rows(page)).toHaveCount(0);

	await test.step("a file the server can't read, picked from the empty area, shows why", async () => {
		await choose(page, documents(page).getByRole("button", { name: "Upload files" }), { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not a document") });
		await expect(documents(page).getByRole("alert")).toHaveText(`“photo.png” can't be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.`);
		await expect(rows(page)).toHaveCount(0);
	});

	const leave = `Staff get 27 days of paid leave a year, code LV-${tag}.`;
	await test.step("a file dropped on the workspace's sections goes from Indexing to Ready", async () => {
		await drag(page, "dragenter");
		await expect(dropState(page)).toBeVisible();
		await drag(page, "drop", { name: "leave-policy.md", text: `# Leave policy\n\n${leave}\n\nAsk your manager before you book a trip.` });
		await expect(dropState(page)).toHaveCount(0);
		const leaveRow = row(page, "leave-policy.md");
		await expect(leaveRow).toContainText("Indexing…");
		await expect(leaveRow).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		await expect(leaveRow).not.toContainText("Indexing…");
		await expect(documents(page).getByRole("alert")).toHaveCount(0);
		// One document: its row, and Upload in place of the empty area.
		await expect(rows(page)).toHaveCount(1);
		await expect(documents(page).getByRole("button", { name: "Upload files" })).toHaveCount(0);
	});

	await test.step("a document that fits goes whole to the model, and the answer quotes it", async () => {
		const question = `How many days of paid leave do staff get, ${tag}?`;
		await chat.send(page, question);
		await expect(chat.reply(page)).toContainText(`From the document “leave-policy.md”: ${leave}`);
		const [call] = await fake.calls(question);
		expect(call.system).toContain('<document name="leave-policy.md">');
		expect(call.tools).not.toContain("workspace_search");
		expect(userMessages(call)).not.toContain("<workspace_excerpts>");
	});

	const permit = `The visitor parking permit code is PK-${tag}.`;
	await test.step("a document too large for the model's window is searched, and the answer quotes its passage", async () => {
		await page.goto(`/?w=${slug}`);
		await choose(page, documents(page).getByRole("button", { name: "Upload", exact: true }), textFile("handbook.txt", handbook(permit), "text/plain"));
		await expect(rows(page)).toHaveCount(2);
		await expect(row(page, "handbook.txt")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		await page.getByRole("button", { name: /^Model:/ }).click();
		await page.getByRole("option", { name: /GLM 5\.3/ }).click();
		const question = `What is the visitor parking permit code, ${tag}?`;
		await chat.send(page, question);
		await expect(chat.reply(page)).toContainText(`From the excerpt “handbook.txt`);
		await expect(chat.reply(page)).toContainText(permit);
		const [call] = await fake.calls(question);
		expect(call.model).toBe("z-ai/glm-5.3");
		expect(call.tools).toContain("workspace_search");
		expect(userMessages(call)).toContain("<workspace_excerpts>");
		expect(userMessages(call)).toContain(permit);
		expect(call.system).not.toContain('<document name="handbook.txt">');
		// The small document still fits, and stays whole.
		expect(call.system).toContain('<document name="leave-policy.md">');
	});
});

test("8. an editor sees a document's steps in Details; a person who can only ask sees its status only", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	await fake.page({ match: `PAGEKEY-ok-${tag}`, text: "Exit site care: clean the exit site every second day." });
	const { id, slug } = await createWorkspace(page, `Dialysis manual ${tag}`);
	const asker = await newPerson(browser, db, fake, "asks only");
	await share(page, id, [{ userId: asker.person.id, access: "ask" }]);

	await test.step("the editor uploads a PDF with a scan; its Details show a summary, and its steps behind Log", async () => {
		await page.goto(`/?w=${slug}`);
		await picker(page).setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: scanPdf("Peritoneal dialysis manual", `PAGEKEY-ok-${tag}`) });
		const manual = row(page, "manual.pdf");
		await expect(manual).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		const { details, menu } = await openDetails(page, "manual.pdf");
		// The summary: what the file is, its status, and the pages a model read.
		await expect(details.locator('[data-slot="document-facts"]')).toHaveText(/^PDF · 2 pages · [\d.,]+ (bytes|KB|MB)$/);
		await expect(details.locator('[data-slot="document-progress"]')).toHaveText(/^Ready · /);
		await expect(details.locator('[data-slot="document-page-reads"]')).toHaveText("1 page was read from a picture");
		const steps = details.locator('[data-slot="document-step"]');
		await expect(steps).toHaveCount(0);

		await details.getByRole("button", { name: "Log" }).click();
		await expect(details.getByRole("button", { name: "Log" })).toHaveAttribute("aria-expanded", "true");
		// Plain steps: the scanned page was read from a picture. Models and costs are the admin's.
		await expect(steps).toHaveText(["Uploaded · PDF, 2 pages", "Read page 2 from a picture", "Ready"]);
		await expect(details).not.toContainText("$");
		await expect(details.getByRole("button", { name: "Try again" })).toHaveCount(0);
		// No text of the document is in the log.
		await expect(details).not.toContainText("Exit site care");
		await details.getByRole("button", { name: "Close" }).click();
		await expect(details).toHaveCount(0);
		await expect(menu).toBeFocused();
	});

	await test.step("a person who can only ask sees the name and status, and no Details, upload or delete", async () => {
		await asker.page.goto(`/?w=${slug}`);
		const manual = row(asker.page, "manual.pdf");
		await expect(manual).toHaveAttribute("data-status", "ready");
		// Ready needs no word, and the size is for editors.
		await expect(manual).toHaveText("manual.pdf");
		// Its one button is the name, which opens the file (test 11).
		await expect(documents(asker.page).getByRole("button")).toHaveText(["manual.pdf"]);
		await expect(rows(asker.page)).toHaveCount(1);
		// No instructions, and nothing to add them with: no Instructions.
		await expect(asker.page.getByRole("region", { name: "Instructions" })).toHaveCount(0);
		await expect(asker.page.locator('[data-slot="document-picker"]')).toHaveCount(0);
		// No chat of theirs here yet, and no setup cards: they can only ask.
		await expect(asker.page.locator('[data-slot="workspace-setup"]')).toHaveCount(0);

		const document = (await documentOf(page, id, "manual.pdf"))!;
		expect((await asker.page.request.get(`/api/workspaces/${id}/documents/${document.id}/log`)).status()).toBe(403);
		expect((await asker.page.request.delete(`/api/workspaces/${id}/documents/${document.id}`)).status()).toBe(403);
		const upload = await asker.page.request.post(`/api/workspaces/${id}/documents`, { multipart: { file: textFile("more.md", "More notes.") } });
		expect(upload.status()).toBe(403);
		expect((await documentOf(page, id, "manual.pdf"))?.status).toBe("ready");
	});

	await asker.context.close();
});

test("9. a document that fails shows its error, and Try again makes it Ready", async ({ page, person, fake }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	// The page model fails the scan once, then reads it.
	await fake.page({ match: `PAGEKEY-fail-${tag}`, failFirst: 1, error: "The fake page model is down.", text: "Exit site care: clean the exit site every second day." });
	const { id, slug } = await createWorkspace(page, `Scans ${tag}`);
	await page.goto(`/?w=${slug}`);
	await picker(page).setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: scanPdf("Scanned forms", `PAGEKEY-fail-${tag}`) });

	const scan = row(page, "scan.pdf");
	await expect(scan).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
	await expect(scan.locator('[data-slot="document-status"]')).toContainText("Could not read page 2");

	const { details } = await openDetails(page, "scan.pdf");
	await test.step("Details name the page, in the row's words", async () => {
		await expect(details.locator('[data-slot="document-status"]')).toHaveText("Could not read page 2");
		// Said once: the page that stopped the run is the status, not a second line.
		await expect(details.locator('[data-slot="document-page-reads"]')).toHaveCount(0);
		await details.getByRole("button", { name: "Log" }).click();
		await expect(details.locator('[data-step="page-read"]')).toContainText("Could not read page 2");
		// The model's own error has no plain words: the admin's log keeps it.
		await expect(details.locator('[data-step="page-read"] [data-slot="document-step-error"]')).toHaveCount(0);
		// Said once: no second step for the run that failed on that page.
		await expect(details.locator('[data-step="failed"]')).toHaveCount(0);
	});

	await test.step("Try again in Details reads it again; the row and Details follow it to Ready", async () => {
		await details.getByRole("button", { name: "Try again" }).click();
		await expect(scan).toHaveAttribute("data-status", "reading");
		await expect(scan.locator('[data-slot="document-status"]')).not.toContainText("Could not read");
		await expect(details.locator('[data-slot="document-progress"]')).toContainText("Indexing…");
		await expect(scan).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
		await expect(scan.locator('[data-slot="document-status"]')).not.toContainText("Could not read");

		await expect(details.locator('[data-slot="document-progress"]')).toHaveText(/^Ready/, { timeout: 15_000 });
		await expect(details.getByRole("button", { name: "Try again" })).toHaveCount(0);
		// The log stays open, with the new run under the old one.
		await expect(details.locator('[data-step="reindexed"]')).toContainText("An editor asked to try again");
		await expect(details.locator('[data-slot="document-step"]').last()).toContainText("Ready");
	});

	await test.step("an editor deletes it, and its Details close", async () => {
		await scan.getByRole("button", { name: "Actions for “scan.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete this document?" }).getByRole("button", { name: "Delete" }).click();
		await expect(rows(page)).toHaveCount(0);
		await expect(details).toHaveCount(0);
		expect(await documentOf(page, id, "scan.pdf")).toBeUndefined();
	});
});

test("9b. while a model reads a PDF's pages, its row and its Details count them, then it is Ready", async ({ page, person, fake }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const key = `PAGEKEY-held-${tag}`;
	// A line of text, then three scans. Each read waits until the test lets it go.
	await fake.page({ match: key, text: "Exit site care: clean the exit site every second day.", hold: true });
	const { slug } = await createWorkspace(page, `Scanned forms ${tag}`);
	await page.goto(`/?w=${slug}`);
	await picker(page).setInputFiles({ name: "forms.pdf", mimeType: "application/pdf", buffer: scanPdf("Ward forms", key, 3) });
	const forms = row(page, "forms.pdf");
	const status = forms.locator('[data-slot="document-status"]');

	await test.step("once the PDF is parsed, the row counts its text page as read", async () => {
		await expect(status).toContainText("Indexing… page 1 of 4", { timeout: 30_000 });
		await expect(forms).toHaveAttribute("data-status", "reading");
	});

	const { details, menu } = await openDetails(page, "forms.pdf");
	const steps = details.locator('[data-slot="document-step"]');
	const progress = details.locator('[data-slot="document-progress"]');
	const reads = details.locator('[data-slot="document-page-reads"]');

	await test.step("Details show the same count, with a bar, and each page once it is read", async () => {
		await expect(progress).toHaveText("Indexing… page 1 of 4");
		await expect(details.getByRole("progressbar")).toBeVisible();
		await expect(details.locator('[data-slot="document-facts"]')).toContainText("PDF · 4 pages · ");
		await details.getByRole("button", { name: "Log" }).click();
		await expect(steps).toHaveText(["Uploaded · PDF, 4 pages"]);

		await fake.releasePage(key);
		await expect(progress).toHaveText("Indexing… page 2 of 4", { timeout: 15_000 });
		await expect(reads).toHaveText("1 page read from a picture so far");
		await expect(steps).toHaveCount(2);
		await expect(steps.nth(1)).toHaveText(/^Read page [234] from a picture$/);
	});

	await test.step("the row and Details follow each page, then say Ready; the log has the pages in one step", async () => {
		await expect(status).toContainText("Indexing… page 2 of 4", { timeout: 15_000 });
		await fake.releasePage(key);
		await expect(status).toContainText("Indexing… page 3 of 4", { timeout: 15_000 });
		await fake.releasePage(key);
		await expect(forms).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		await expect(status).not.toContainText("Indexing");

		await expect(progress).toHaveText(/^Ready · /, { timeout: 15_000 });
		await expect(details.getByRole("progressbar")).toHaveCount(0);
		await expect(reads).toHaveText("3 pages were read from pictures");
		await expect(steps).toHaveText(["Uploaded · PDF, 4 pages", /^Read 3 pages from pictures\s*Pages 2–4$/, "Ready"]);
		await expect(details.locator('[data-step="page-read"] [data-slot="document-step-pages"]')).toHaveText("Pages 2–4");

		await page.keyboard.press("Escape");
		await expect(details).toHaveCount(0);
		await expect(menu).toBeFocused();
	});
});

test("10. the page stops reading an Indexing document again once Details close, the document is gone or the person leaves", async ({ page, person }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const { id, slug } = await createWorkspace(page, `Polls ${tag}`);
	const documentId = await uploadReady(page, id, textFile("notes.md", "Notes."));
	// The page loads the workspace by its slug, then polls it by its id.
	const workspacePaths = [`/api/workspaces/${slug}`, `/api/workspaces/${id}`];
	const logPath = `/api/workspaces/${id}/documents/${documentId}/log`;

	// The document stays Indexing for the page, so it keeps polling, and each workspace answer takes a moment.
	await page.route(
		(url) => workspacePaths.includes(url.pathname),
		async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const response = await route.fetch();
			const body = await jsonOf<{ workspace: { documents: { status: string }[] } }>(response);
			for (const document of body.workspace.documents) document.status = "reading";
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.fulfill({ response, json: body });
		},
	);
	await page.route(
		(url) => url.pathname === logPath,
		async (route) => {
			const response = await route.fetch();
			if (!response.ok()) return route.fulfill({ response });
			const body = await jsonOf<{ document: { status: string } }>(response);
			body.document.status = "reading";
			await route.fulfill({ response, json: body });
		},
	);
	const sent = { workspace: 0, log: 0 };
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET" && workspacePaths.includes(path)) sent.workspace++;
		if (path === logPath) sent.log++;
	});
	/** Nothing more is asked for in the next few seconds, longer than any wait between polls here. */
	const quiet = async (kind: keyof typeof sent, ms: number) => {
		const before = sent[kind];
		await page.waitForTimeout(ms);
		expect(sent[kind], `${kind} requests after it should stop`).toBe(before);
	};
	const notes = row(page, "notes.md");
	await page.goto(`/?w=${id}`);
	await expect(notes).toHaveAttribute("data-status", "reading");

	await test.step("closing Details stops reading the log", async () => {
		const { details } = await openDetails(page, "notes.md");
		await expect.poll(() => sent.log, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
		await details.getByRole("button", { name: "Close" }).click();
		await expect(details).toHaveCount(0);
		await quiet("log", 5000);
	});

	await test.step("leaving the workspace while it is being read stops reading it", async () => {
		const asked = sent.workspace;
		await expect.poll(() => sent.workspace, { timeout: 15_000 }).toBeGreaterThan(asked);
		// The poll's answer is still on its way.
		await page.getByRole("button", { name: "New chat" }).first().click();
		await expect(page).not.toHaveURL(/[?&]w=/);
		// Longer than the longest wait between polls (10 s).
		await quiet("workspace", 12_000);
	});

	await test.step("a deleted document's log is not asked for again", async () => {
		await page.goto(`/?w=${id}`);
		const { details } = await openDetails(page, "notes.md");
		await expect.poll(() => sent.log, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
		await expect(details.locator('[data-slot="document-progress"]')).toHaveText("Indexing…");
		const gone = page.waitForResponse((response) => new URL(response.url()).pathname === logPath && response.status() === 404, { timeout: 10_000 });
		expect((await page.request.delete(`/api/workspaces/${id}/documents/${documentId}`)).ok()).toBe(true);
		await gone;
		await quiet("log", 5000);
	});
});

test("10c. a person removed while a document is Indexing: the next read of the workspace says it is gone, and closes its Details", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const name = `Removed while read ${tag}`;
	const { id, slug } = await createWorkspace(page, name);
	await uploadReady(page, id, textFile("notes.md", "Notes."));
	const editor = await newPerson(browser, db, fake, "removed editor");
	await share(page, id, [{ userId: editor.person.id, access: "edit" }]);
	// For the editor, the document stays Indexing, so the page keeps reading the workspace.
	await editor.page.route(
		(url) => [`/api/workspaces/${slug}`, `/api/workspaces/${id}`].includes(url.pathname),
		async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const response = await route.fetch();
			if (!response.ok()) return route.fulfill({ response });
			const body = await jsonOf<{ workspace: { documents: { status: string }[] } }>(response);
			for (const document of body.workspace.documents) document.status = "reading";
			await route.fulfill({ response, json: body });
		},
	);
	// Its Details say so too: they would otherwise tell the page it is Ready.
	await editor.page.route(
		(url) => url.pathname.startsWith(`/api/workspaces/${id}/documents/`) && url.pathname.endsWith("/log"),
		async (route) => {
			const response = await route.fetch();
			if (!response.ok()) return route.fulfill({ response });
			const body = await jsonOf<{ document: { status: string } }>(response);
			body.document.status = "reading";
			await route.fulfill({ response, json: body });
		},
	);
	await editor.page.goto(`/?w=${slug}`);
	await expect(row(editor.page, "notes.md")).toHaveAttribute("data-status", "reading");
	const { details } = await openDetails(editor.page, "notes.md");

	const refusals: number[] = [];
	editor.page.on("response", (response) => new URL(response.url()).pathname === `/api/workspaces/${id}` && response.status() >= 400 && refusals.push(response.status()));
	expect((await page.request.delete(`/api/workspaces/${id}/members/${editor.person.id}`)).ok()).toBe(true);
	// The next poll, at most a few seconds on.
	await expect.poll(() => refusals.length, { timeout: 15_000 }).toBeGreaterThan(0);
	await expect(editor.page.getByText("No workspace here")).toBeVisible();
	await expect(row(editor.page, "notes.md")).toHaveCount(0);
	await expect(details).toHaveCount(0);
	await expect(editor.page.locator('[data-slot="workspace-rows"]').getByRole("button", { name, exact: true })).toHaveCount(0);
	await editor.context.close();
});

test("10b. Details closed while Try again is on its way do not read the log again, and an older log never undoes the row's Ready", async ({ page, person }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const { id } = await createWorkspace(page, `Races ${tag}`);
	const documentId = await uploadReady(page, id, textFile("notes.md", "Notes."));
	const logPath = `/api/workspaces/${id}/documents/${documentId}/log`;
	const retryPath = `/api/workspaces/${id}/documents/${documentId}/retry`;
	const notes = row(page, "notes.md");

	// What the page is told about the document, whatever the server says: set by each step.
	const told: { status: string; error: string | null } = { status: "failed", error: "upstream exploded" };
	let holdLog: Promise<void> | null = null;
	let logHeld = false;
	await page.route(
		(url) => url.pathname === `/api/workspaces/${id}`,
		async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const response = await route.fetch();
			const body = await jsonOf<{ workspace: { documents: { status: string; error: string | null }[] } }>(response);
			for (const document of body.workspace.documents) Object.assign(document, told);
			await route.fulfill({ response, json: body });
		},
	);
	await page.route(
		(url) => url.pathname === logPath,
		async (route) => {
			const said = { ...told };
			const wait = holdLog;
			holdLog = null;
			if (wait) logHeld = true;
			const response = await route.fetch();
			const body = await jsonOf<{ document: { status: string; error: string | null } }>(response);
			Object.assign(body.document, said);
			await wait;
			await route.fulfill({ response, json: body });
		},
	);
	let logs = 0;
	page.on("request", (request) => new URL(request.url()).pathname === logPath && logs++);

	await page.goto(`/?w=${id}`);
	await expect(notes).toHaveAttribute("data-status", "failed");

	await test.step("Try again, then Details close before its answer: no more reads of the log", async () => {
		let answerRetry = () => {};
		const retryAnswered = new Promise<void>((resolve) => (answerRetry = resolve));
		await page.route(
			(url) => url.pathname === retryPath,
			async (route) => {
				await retryAnswered;
				const document = (await jsonOf<{ document: Record<string, unknown> }>(await route.fetch({ method: "GET", url: new URL(logPath, page.url()).href }))).document;
				await route.fulfill({ json: { document: { ...document, status: "reading", error: null } } });
			},
		);
		const { details } = await openDetails(page, "notes.md");
		await expect(details.locator('[data-slot="document-status"]')).toHaveText("Could not read it");
		await details.getByRole("button", { name: "Try again" }).click();
		await details.getByRole("button", { name: "Close" }).click();
		await expect(details).toHaveCount(0);
		const before = logs;
		answerRetry();
		await expect(notes).toHaveAttribute("data-status", "reading");
		await page.waitForTimeout(5000);
		expect(logs, "log reads after Details closed").toBe(before);
		await page.unroute((url) => url.pathname === retryPath);
	});

	await test.step("a log read on its way when the row sees Ready does not turn it back to Indexing", async () => {
		Object.assign(told, { status: "reading", error: null });
		const { details } = await openDetails(page, "notes.md");
		const progress = details.locator('[data-slot="document-progress"]');
		await expect(progress).toHaveText("Indexing…");
		// The next log read waits, still saying Indexing, while the page's own poll says Ready.
		let releaseLog = () => {};
		holdLog = new Promise<void>((resolve) => (releaseLog = resolve));
		await expect.poll(() => logHeld, { timeout: 10_000 }).toBe(true);
		told.status = "ready";
		await expect(notes).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
		await expect(progress).toHaveText(/^Ready/, { timeout: 10_000 });
		releaseLog();
		// Not even for a moment: the next poll would put Ready back, so look often.
		for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
			expect(await notes.getAttribute("data-status"), "the row's status after the older log came").toBe("ready");
			expect(await progress.textContent(), "Details after the older log came").toMatch(/^\s*Ready/);
			await page.waitForTimeout(100);
		}
	});
});

test("11. a person who can only ask opens a document in the side viewer; a person outside the workspace can't get the file", async ({ page, person, fake, db, browser }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const { id, slug } = await createWorkspace(page, `Ward reports ${tag}`);
	await uploadReady(page, id, textFile("handover.md", `# Night shift handover\n\nCheck each bed before you leave, ${tag}.`));
	const pdfId = await uploadReady(page, id, { name: "report.pdf", mimeType: "application/pdf", buffer: textPdf(["Ward report", "Beds and staff"]) });
	const asker = await newPerson(browser, db, fake, "opens documents");
	await share(page, id, [{ userId: asker.person.id, access: "ask" }]);
	await asker.page.goto(`/?w=${slug}`);
	const panel = asker.page.locator('[data-slot="side-panel"]');

	await test.step("a Markdown document opens with its name and text", async () => {
		await row(asker.page, "handover.md").getByRole("button", { name: "handover.md" }).click();
		await expect(panel.getByRole("heading", { name: "handover.md" })).toBeVisible();
		await expect(panel.locator('[data-slot="text-file"]')).toContainText(`Check each bed before you leave, ${tag}.`);
		await expect(panel.locator('[data-slot="text-file"] h1')).toHaveText("Night shift handover");
		// Escape closes the first file the panel opened, too.
		await asker.page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
	});

	await test.step("a PDF opens as its drawn pages", async () => {
		await row(asker.page, "report.pdf").getByRole("button", { name: "report.pdf" }).click();
		await expect(panel.getByRole("heading", { name: "report.pdf" })).toBeVisible();
		const first = panel.getByRole("img", { name: "Page 1 of 2" });
		await expect(first.locator("canvas")).toBeVisible();
		// Drawn: its loading skeleton is gone.
		await expect(first.locator(".fui-skeleton")).toHaveCount(0);
		await asker.page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
	});

	await test.step("on a phone the viewer covers the page: focus moves into it, the page behind takes none, and comes back on close", async () => {
		await asker.page.setViewportSize({ width: 390, height: 844 });
		const opener = row(asker.page, "handover.md").getByRole("button", { name: "handover.md" });
		await opener.click();
		await expect(panel.locator('[data-slot="text-file"]')).toContainText("Night shift handover");
		await expect(panel).toBeFocused();
		await expect(asker.page.locator('[data-slot="chat-column"]')).toHaveAttribute("inert", "");
		for (let tab = 0; tab < 4; tab++) {
			await asker.page.keyboard.press("Tab");
			// Past its last control focus leaves the page (the body), never for a control behind it.
			expect(await asker.page.evaluate(() => document.activeElement === document.body || Boolean(document.activeElement?.closest('[data-slot="side-panel"]'))), "no control behind the viewer takes focus").toBe(true);
		}
		await asker.page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(asker.page.locator('[data-slot="chat-column"]')).not.toHaveAttribute("inert");
		await expect(opener).toBeFocused();
		await asker.page.setViewportSize({ width: 1280, height: 720 });
	});

	await test.step("an editor deletes the document that is open: the viewer closes", async () => {
		await page.goto(`/?w=${slug}`);
		const ownerPanel = page.locator('[data-slot="side-panel"]');
		const handover = row(page, "handover.md");
		await handover.getByRole("button", { name: "handover.md", exact: true }).click();
		await expect(ownerPanel.getByRole("heading", { name: "handover.md" })).toBeVisible();
		await handover.getByRole("button", { name: "Actions for “handover.md”" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete this document?" }).getByRole("button", { name: "Delete" }).click();
		await expect(handover).toHaveCount(0);
		await expect(ownerPanel).toHaveCount(0);
	});

	await test.step("a person outside the workspace gets 404 for the file", async () => {
		const outsider = await newPerson(browser, db, fake, "not a member");
		expect((await outsider.page.request.get(`/api/workspaces/${id}/documents/${pdfId}/file`)).status()).toBe(404);
		await outsider.context.close();
	});

	await asker.context.close();
});

/** What the person's messages sent to the model hold, without the system prompt, which names the excerpts block too. */
function userMessages(call: ReceivedCall) {
	return JSON.stringify((call.messages as { role: string }[]).filter((message) => message.role === "user"));
}

/** Clicks a button that opens the file picker, and picks the file. */
async function choose(page: Page, button: Locator, file: Upload) {
	const chooser = page.waitForEvent("filechooser");
	await button.click();
	await (await chooser).setFiles(file);
}

/** Drags a file over the documents list (dragenter), or drops it there. */
async function drag(page: Page, type: "dragenter" | "drop", file = { name: "notes.md", text: "Notes." }) {
	await documents(page).evaluate(
		(section, { type, file }) => {
			const data = new DataTransfer();
			data.items.add(new File([file.text], file.name, { type: "text/markdown" }));
			const events = type === "drop" ? ["dragover", "drop"] : ["dragenter", "dragover"];
			for (const name of events) section.dispatchEvent(new DragEvent(name, { dataTransfer: data, bubbles: true, cancelable: true }));
		},
		{ type, file },
	);
}

/** About 100,000 characters in paragraphs, with `line` in the middle. No other paragraph shares its words. */
function handbook(line: string) {
	const paragraphs = Array.from({ length: 900 }, (_, index) => `Section ${index + 1}. Shared desks are cleaned each evening, and kitchen supplies arrive every Monday morning.`);
	paragraphs.splice(450, 0, line);
	return `# Office handbook\n\n${paragraphs.join("\n\n")}`;
}
