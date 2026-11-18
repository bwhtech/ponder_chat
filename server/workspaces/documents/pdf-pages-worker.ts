/// <reference path="../../pdfjs-worker.d.ts" />
import { parentPort, workerData } from "node:worker_threads";

/**
 * The worker thread that copies single pages out of a PDF, as one-page PDFs, with pdf.js's
 * extractPages (pdf-pages.ts starts it, and stops it when it takes too long). It gets the
 * PDF's bytes and the page numbers, and posts back one PDF for each page, in that order.
 *
 * This file imports only pdf.js. The build makes it a file of its own (nitro.config.ts),
 * and a shared module would run the server's code in this thread.
 */
const { data, pages } = workerData as { data: Uint8Array; pages: number[] };
const copies = await onePagePdfs(data, pages);
parentPort?.postMessage(copies, copies.map((copy) => copy.buffer as ArrayBuffer));

async function onePagePdfs(bytes: Uint8Array, numbers: number[]) {
	const pdfjs = await loadPdfjs();
	const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
	try {
		const pdf = await task.promise;
		const copies: Uint8Array[] = [];
		// extractPages counts pages from 0.
		for (const number of numbers) copies.push(await pdf.extractPages([{ document: null, includePages: [number - 1] }]));
		return copies;
	} finally {
		await task.destroy();
	}
}

/** pdf.js runs its own worker on this thread when it finds it on globalThis: no second worker file to locate after bundling. */
async function loadPdfjs() {
	const scope = globalThis as { pdfjsWorker?: unknown };
	scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
	return import("pdfjs-dist/legacy/build/pdf.mjs");
}
