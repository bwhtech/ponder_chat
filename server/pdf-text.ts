/**
 * The text of a PDF, read once on this server with pdf.js, so that a model that cannot
 * read PDFs gets plain text instead of the PDF being parsed again on every call.
 * A scanned PDF has little or no text layer: that gives "", and the model gets the PDF.
 */
const MIN_CHARS_PER_PAGE = 40;

export async function extractPdfText(data: Buffer): Promise<string> {
	const pdfjs = await loadPdfjs();
	const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false });
	try {
		const pdf = await task.promise;
		const pages: string[] = [];
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			pages.push(pageText((await page.getTextContent()).items));
			page.cleanup();
		}
		const total = pages.reduce((sum, text) => sum + text.length, 0);
		if (total < MIN_CHARS_PER_PAGE * pdf.numPages) return "";
		return pages.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join("\n\n");
	} finally {
		await task.destroy();
	}
}

/** pdf.js runs its worker on the main thread when it finds it on globalThis: no worker file to locate after bundling. */
async function loadPdfjs() {
	const scope = globalThis as { pdfjsWorker?: unknown };
	// @ts-expect-error The worker module has no types.
	scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
	return import("pdfjs-dist/legacy/build/pdf.mjs");
}

function pageText(items: unknown[]) {
	let text = "";
	for (const item of items as { str?: string; hasEOL?: boolean }[]) {
		if (item.str === undefined) continue;
		text += item.str + (item.hasEOL ? "\n" : "");
	}
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
