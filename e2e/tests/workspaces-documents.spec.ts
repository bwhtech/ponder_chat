import type { Page } from "@playwright/test";
import type { ReceivedCall } from "../fake/script.ts";
import { chat, expect, test } from "../fixtures.ts";
import { scanPdf } from "../pdfs.ts";
import { createWorkspace, documentOf, newPerson, share, textFile } from "../workspaces.ts";

/**
 * Workspace documents (docs/workspaces-plan.md, "Tests", 7 to 9): an editor uploads a document,
 * it goes from Reading to Ready, and answers use it, whole when it fits the model's window and
 * as searched passages when it does not; the indexing log in Details, for editors only; and a
 * document that fails, then reads on "Try again".
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

test("7. an editor uploads documents; they go from Reading to Ready, and answers use them whole or searched", async ({ page, person, fake }) => {
	test.setTimeout(120_000);
	const tag = person.id.slice(0, 6);
	const id = await createWorkspace(page, `Office handbook ${tag}`);
	await page.goto(`/?w=${id}`);
	await expect(documents(page).getByText("Drop files here, or choose them")).toBeVisible();

	await test.step("a file the server can't read shows why", async () => {
		await picker(page).setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("not a document") });
		await expect(documents(page).getByRole("alert")).toHaveText(`"photo.png" can't be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.`);
		await expect(rows(page)).toHaveCount(0);
	});

	const leave = `Staff get 27 days of paid leave a year, code LV-${tag}.`;
	await test.step("a file dropped on the list goes from Reading to Ready", async () => {
		await drag(page, "dragenter");
		await expect(documents(page).getByText("Drop to add to this workspace")).toBeVisible();
		await drag(page, "drop", { name: "leave-policy.md", text: `# Leave policy\n\n${leave}\n\nAsk your manager before you book a trip.` });
		await expect(documents(page).getByText("Drop to add to this workspace")).toHaveCount(0);
		const leaveRow = row(page, "leave-policy.md");
		await expect(leaveRow).toContainText("Reading…");
		await expect(leaveRow).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		await expect(leaveRow).toContainText("Ready");
		await expect(documents(page).getByRole("alert")).toHaveCount(0);
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
		await page.goto(`/?w=${id}`);
		await picker(page).setInputFiles(textFile("handbook.txt", handbook(permit), "text/plain"));
		await expect(row(page, "handbook.txt")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		await page.getByRole("button", { name: /Model/ }).click();
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
	const id = await createWorkspace(page, `Dialysis manual ${tag}`);
	const asker = await newPerson(browser, db, fake, "asks only");
	await share(page, id, [{ userId: asker.person.id, access: "ask" }]);

	await test.step("the editor uploads a PDF with a scan, and its Details show each step", async () => {
		await page.goto(`/?w=${id}`);
		await picker(page).setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: scanPdf("Peritoneal dialysis manual", `PAGEKEY-ok-${tag}`) });
		const manual = row(page, "manual.pdf");
		await expect(manual).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		await manual.getByRole("button", { name: "Actions for “manual.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		const details = page.getByRole("dialog", { name: "manual.pdf" });
		const steps = details.locator('[data-slot="document-step"]');
		await expect(steps).toHaveText([/^Uploaded/, /^Read the text/, /^Page 2 read by a model/, /^Split into passages/, /^Embedded batch 1/, /^Ready/]);
		await expect(details.locator('[data-step="parsed"]')).toContainText("LiteParse · 2 pages");
		// The scan went to the model, which says why and what it cost.
		await expect(details.locator('[data-step="page-read"]')).toContainText("Page 2 read by a model");
		await expect(details.locator('[data-step="page-read"]')).toContainText("A scan, with no text");
		await expect(details.locator('[data-step="page-read"]')).toContainText("$0.0018");
		await expect(details.locator('[data-step="chunked"]')).toContainText("Split into passages");
		await expect(details.locator('[data-step="embedded"]')).toContainText("Embedded batch 1");
		await expect(details.locator('[data-step="ready"]')).toContainText("in total");
		await expect(details.getByRole("button", { name: "Try again" })).toHaveCount(0);
		// No text of the document is in the log.
		await expect(details).not.toContainText("Exit site care");
		await details.getByRole("button", { name: "Close" }).first().click();
		await expect(details).toHaveCount(0);
	});

	await test.step("a person who can only ask sees the name and status, and no Details, upload or delete", async () => {
		await asker.page.goto(`/?w=${id}`);
		const manual = row(asker.page, "manual.pdf");
		await expect(manual).toContainText("Ready");
		await expect(manual.getByRole("button")).toHaveCount(0);
		await expect(documents(asker.page).getByRole("button")).toHaveCount(0);
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
	const id = await createWorkspace(page, `Scans ${tag}`);
	await page.goto(`/?w=${id}`);
	await picker(page).setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: scanPdf("Scanned forms", `PAGEKEY-fail-${tag}`) });

	const scan = row(page, "scan.pdf");
	await expect(scan).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
	await expect(scan.locator('[data-slot="document-status"]')).toContainText("Failed");
	await expect(scan.locator('[data-slot="document-error"]')).toHaveText("Page 2 has no text, and the model could not read it.");

	await test.step("Details name the page and the model's error", async () => {
		await scan.getByRole("button", { name: "Actions for “scan.pdf”" }).click();
		await page.getByRole("menuitem", { name: "Details" }).click();
		const details = page.getByRole("dialog", { name: "scan.pdf" });
		await expect(details.locator('[data-step="page-read"]')).toContainText("Page 2 read by a model");
		await expect(details.locator('[data-step="page-read"] [data-slot="document-step-error"]')).toHaveText("The fake page model is down.");
		await expect(details.locator('[data-step="failed"]')).toContainText("Failed while reading a page with a model");
		await expect(details.locator('[data-step="failed"]')).toContainText("Page 2");
		await expect(details.getByRole("button", { name: "Try again" })).toBeVisible();
		await details.getByRole("button", { name: "Close" }).first().click();
		await expect(details).toHaveCount(0);
	});

	await test.step("Try again reads it again, and it is Ready", async () => {
		await scan.getByRole("button", { name: "Try again" }).click();
		await expect(scan).toHaveAttribute("data-status", "reading");
		await expect(scan.locator('[data-slot="document-error"]')).toHaveCount(0);
		await expect(scan).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
		await expect(scan.locator('[data-slot="document-status"]')).toContainText("Ready");

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

/** What the person's messages sent to the model hold, without the system prompt, which names the excerpts block too. */
function userMessages(call: ReceivedCall) {
	return JSON.stringify((call.messages as { role: string }[]).filter((message) => message.role === "user"));
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
