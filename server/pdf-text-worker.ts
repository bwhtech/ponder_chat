import { parentPort, workerData } from "node:worker_threads";

/**
 * The worker thread that reads a PDF's text with pdf.js (pdf-text.ts starts it, and stops
 * it when it takes too long). It gets the PDF's bytes and posts the text back.
 * A scanned PDF has little or no text layer: that gives "", and the model gets the PDF.
 *
 * This file imports only pdf.js. The build makes it a file of its own (nitro.config.ts),
 * and a shared module would run the server's code in this thread.
 */
const MIN_CHARS_PER_PAGE = 40;

parentPort?.postMessage(await pdfText(workerData as Uint8Array));

async function pdfText(data: Uint8Array): Promise<string> {
	const pdfjs = await loadPdfjs();
	const task = pdfjs.getDocument({ data, useSystemFonts: false });
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

/** pdf.js runs its own worker on this thread when it finds it on globalThis: no second worker file to locate after bundling. */
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
