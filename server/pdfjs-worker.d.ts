// pdf.js ships no types for its worker module. Ponder only puts the module on
// globalThis.pdfjsWorker, where pdf.js looks for it (pdfjs-text.ts, pdf-pages-worker.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
	export const WorkerMessageHandler: unknown;
}
