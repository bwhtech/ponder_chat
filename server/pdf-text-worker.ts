import { parentPort, workerData } from "node:worker_threads";
import { readTextLayer } from "./pdfjs-text.ts";

/**
 * The worker thread that reads a PDF's text with pdf.js (pdf-text.ts starts it, and stops
 * it when it takes too long). It gets the PDF's bytes and posts the text back, or null
 * when the text is longer than MAX_CHARS. A scanned PDF has little or no text layer: that
 * gives "", and the model gets the PDF.
 *
 * This file imports only pdf.js (pdfjs-text.ts). The build makes it a file of its own
 * (nitro.config.ts), and a shared module would run the server's code in this thread.
 */
/** Twice the upload limit of 10 MB: a PDF whose text is longer is made to be. */
const MAX_CHARS = 20_000_000;

const pdf: unknown = workerData;
if (!(pdf instanceof Uint8Array)) throw new TypeError("The worker needs the PDF's bytes.");
const layer = await readTextLayer(pdf, { maxPages: Infinity, maxChars: MAX_CHARS });
parentPort?.postMessage("tooLarge" in layer ? null : layer.pages.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join("\n\n"));
