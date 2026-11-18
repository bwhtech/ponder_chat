/**
 * A PDF's text layer, page by page, with pdf.js. Only worker threads run it: the one of
 * pdf-text.ts, for a PDF attached to a chat, and the one of prepare-text.ts, for a
 * workspace PDF that LiteParse can't read here. So it imports only pdf.js: a module of
 * the server would run the server's code in those threads.
 *
 * A scanned PDF has little or no text layer: that gives no pages. A PDF can hold far more
 * text than its size suggests (a compressed stream), so the read stops past a limit, and
 * the thread never posts the text.
 */
const MIN_CHARS_PER_PAGE = 40;

export type TextLayer = { readonly pages: string[] } | { readonly tooLarge: "pages" | "text" };

export async function readTextLayer(data: Uint8Array, limits: { readonly maxPages: number; readonly maxChars: number }): Promise<TextLayer> {
	const pdfjs = await loadPdfjs();
	const task = pdfjs.getDocument({ data, useSystemFonts: false });
	try {
		const pdf = await task.promise;
		if (pdf.numPages > limits.maxPages) return { tooLarge: "pages" };
		const pages: string[] = [];
		let total = 0;
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			pages.push(pageText((await page.getTextContent()).items));
			page.cleanup();
			total += pages[pages.length - 1].length;
			if (total > limits.maxChars) return { tooLarge: "text" };
		}
		return { pages: total < MIN_CHARS_PER_PAGE * pdf.numPages ? [] : pages };
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
