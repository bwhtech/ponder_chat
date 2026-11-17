import type { Locator, Page } from "@playwright/test";
import type { ReceivedCall } from "../fake/script.ts";
import { chat, expect, test } from "../fixtures.ts";
import { scanPdf, textPdf } from "../pdfs.ts";
import { createWorkspace, documentOf, newPerson, share, textFile, uploadReady, type Upload } from "../workspaces.ts";

/**
 * Workspace documents (docs/workspaces-plan.md, "Tests", 7 to 9): an editor uploads a document,
 * it goes from Reading to Ready, and answers use it, whole when it fits the model's window and
 * as searched passages when it does not; the indexing log in Details, for editors only; and a
 * document that fails, then reads on "Try again"; and a document opened in the side viewer.
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
const dropState = (page: Page) => page.locator('[data-slot="workspace-aside"] [data-slot="document-drop"]');

test("7. an editor uploads documents; they go from Reading to Ready, and answers use them whole or searched", async ({ page, person, fake }) => {
	test.setTimeout(120_000);
	const tag = person.id.slice(0, 6);
	const { id, slug } = await createWorkspace(page, `Office handbook ${tag}`);
	await page.goto(`/?w=${slug}`);
	// No documents yet: the section is one "Upload documents" area, and no count.
	await expect(documents(page).getByRole("button", { name: "Upload", exact: true })).toHaveCount(0);
	await expect(documents(page).locator('[data-slot="document-count"]')).toHaveCount(0);
	await expect(rows(page)).toHaveCount(0);

	await test.step("a file the server can't read, picked from the empty area, shows why", async () => {
		await choose(page, documents(page).getByRole("button", { name: "Upload documents" }), { name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not a document") });
		await expect(documents(page).getByRole("alert")).toHaveText(`“photo.png” can't be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.`);
		await expect(rows(page)).toHaveCount(0);
	});

	const leave = `Staff get 27 days of paid leave a year, code LV-${tag}.`;
	await test.step("a file dropped on the side panel goes from Reading to Ready", async () => {
		await drag(page, "dragenter");
		await expect(dropState(page)).toBeVisible();
		await drag(page, "drop", { name: "leave-policy.md", text: `# Leave policy\n\n${leave}\n\nAsk your manager before you book a trip.` });
		await expect(dropState(page)).toHaveCount(0);
		const leaveRow = row(page, "leave-policy.md");
		await expect(leaveRow).toContainText("Reading…");
		await expect(leaveRow).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		await expect(leaveRow).not.toContainText("Reading…");
		await expect(documents(page).getByRole("alert")).toHaveCount(0);
		// One document: its count by the heading, and Upload in place of the empty area.
		await expect(documents(page).locator('[data-slot="document-count"]')).toHaveText("1");
		await expect(documents(page).getByRole("button", { name: "Upload documents" })).toHaveCount(0);
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
		await expect(documents(page).locator('[data-slot="document-count"]')).toHaveText("2");
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

	await test.step("the editor uploads a PDF with a scan, and its Details show each step", async () => {
		await page.goto(`/?w=${slug}`);
		await picker(page).setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: scanPdf("Peritoneal dialysis manual", `PAGEKEY-ok-${tag}`) });
		const manual = row(page, "manual.pdf");
		await expect(manual).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		await manual.getByRole("button", { name: "Actions for “manual.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		const details = page.getByRole("dialog", { name: "manual.pdf" });
		const steps = details.locator('[data-slot="document-step"]');
		// Plain steps: the scanned page was read from a picture. Models and costs are the admin's.
		await expect(steps).toHaveText(["Uploaded · PDF, 2 pages", "Read page 2 from a picture", "Ready"]);
		await expect(details).not.toContainText("$");
		await expect(details.getByRole("button", { name: "Try again" })).toHaveCount(0);
		// No text of the document is in the log.
		await expect(details).not.toContainText("Exit site care");
		await details.getByRole("button", { name: "Close" }).first().click();
		await expect(details).toHaveCount(0);
	});

	await test.step("a person who can only ask sees the name and status, and no Details, upload or delete", async () => {
		await asker.page.goto(`/?w=${slug}`);
		const manual = row(asker.page, "manual.pdf");
		await expect(manual).toHaveAttribute("data-status", "ready");
		// Ready needs no word, and the size is for editors.
		await expect(manual).toHaveText("manual.pdf");
		// Its one button is the name, which opens the file (test 11).
		await expect(documents(asker.page).getByRole("button")).toHaveText(["manual.pdf"]);
		await expect(documents(asker.page).locator('[data-slot="document-count"]')).toHaveText("1");
		// No instructions, and nothing to add them with: no Instructions.
		await expect(asker.page.getByRole("region", { name: "Instructions" })).toHaveCount(0);
		await expect(asker.page.locator('[data-slot="document-picker"]')).toHaveCount(0);

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

	await test.step("Details name the page, in the row's words", async () => {
		await scan.getByRole("button", { name: "Actions for “scan.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		const details = page.getByRole("dialog", { name: "scan.pdf" });
		await expect(details.locator('[data-step="page-read"]')).toContainText("Could not read page 2");
		// The model's own error has no plain words: the admin's log keeps it.
		await expect(details.locator('[data-step="page-read"] [data-slot="document-step-error"]')).toHaveCount(0);
		// Said once: no second step for the run that failed on that page.
		await expect(details.locator('[data-step="failed"]')).toHaveCount(0);
		await expect(details.getByRole("button", { name: "Try again" })).toBeVisible();
		await details.getByRole("button", { name: "Close" }).first().click();
		await expect(details).toHaveCount(0);
	});

	await test.step("Try again reads it again, and it is Ready", async () => {
		await scan.getByRole("button", { name: "Try again" }).click();
		await expect(scan).toHaveAttribute("data-status", "reading");
		await expect(scan.locator('[data-slot="document-status"]')).not.toContainText("Could not read");
		await expect(scan).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
		await expect(scan.locator('[data-slot="document-status"]')).not.toContainText("Could not read");

		await scan.getByRole("button", { name: "Actions for “scan.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		const details = page.getByRole("dialog", { name: "scan.pdf" });
		await expect(details.locator('[data-step="reindexed"]')).toContainText("An editor asked to try again");
		await expect(details.locator('[data-slot="document-step"]').last()).toContainText("Ready");
	});

	await test.step("an editor deletes it", async () => {
		await page.keyboard.press("Escape");
		await scan.getByRole("button", { name: "Actions for “scan.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete this document?" }).getByRole("button", { name: "Delete" }).click();
		await expect(rows(page)).toHaveCount(0);
		expect(await documentOf(page, id, "scan.pdf")).toBeUndefined();
	});
});

test("10. the page stops reading a Reading document again once Details close, the document is gone or the person leaves", async ({ page, person }) => {
	test.setTimeout(90_000);
	const tag = person.id.slice(0, 6);
	const { id, slug } = await createWorkspace(page, `Polls ${tag}`);
	const documentId = await uploadReady(page, id, textFile("notes.md", "Notes."));
	// The page loads the workspace by its slug, then polls it by its id.
	const workspacePaths = [`/api/workspaces/${slug}`, `/api/workspaces/${id}`];
	const logPath = `/api/workspaces/${id}/documents/${documentId}/log`;

	// The document stays Reading for the page, so it keeps polling, and each workspace answer takes a moment.
	await page.route(
		(url) => workspacePaths.includes(url.pathname),
		async (route) => {
			if (route.request().method() !== "GET") return route.fallback();
			const response = await route.fetch();
			const body = (await response.json()) as { workspace: { documents: { status: string }[] } };
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
			const body = (await response.json()) as { document: { status: string } };
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
	const openDetails = async () => {
		await notes.getByRole("button", { name: "Actions for “notes.md”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		return page.getByRole("dialog", { name: "notes.md" });
	};

	await page.goto(`/?w=${id}`);
	await expect(notes).toHaveAttribute("data-status", "reading");

	await test.step("closing Details stops reading the log", async () => {
		const details = await openDetails();
		await expect.poll(() => sent.log, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
		await details.getByRole("button", { name: "Close" }).first().click();
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
		const details = await openDetails();
		await expect.poll(() => sent.log, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
		await expect(details.locator('[data-slot="document-step"]').first()).toBeVisible();
		const gone = page.waitForResponse((response) => new URL(response.url()).pathname === logPath && response.status() === 404, { timeout: 10_000 });
		expect((await page.request.delete(`/api/workspaces/${id}/documents/${documentId}`)).ok()).toBe(true);
		await gone;
		await quiet("log", 5000);
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
