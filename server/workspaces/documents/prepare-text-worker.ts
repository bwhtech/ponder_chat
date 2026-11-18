import { parentPort, workerData } from "node:worker_threads";
import { chunkWithin, type Passage } from "./chunk.ts";
import { MAX_TEXT_CHARS, PASSAGE_BUDGET } from "./limits.ts";
import { parsePdf } from "./parse-pdf.ts";
import type { JobAnswer, PrepareJob, PreparedText, TextRead } from "./prepare-text.ts";
import { headingRule, PDF_TYPE, readText, storedPages, storedText } from "./read-document.ts";

/**
 * The worker thread that reads documents and splits their text into passages
 * (prepare-text.ts starts it, and stops it when it takes too long). It gets one job and
 * posts one answer, which it checks against the limits (limits.ts) first: the server's
 * thread copies what it posts before it can look at it.
 *
 * It imports only the pure modules of reading and chunking, LiteParse and pdf.js, and
 * Effect's data types. The build makes it a file of its own (nitro.config.ts), and a
 * module of the server would run the server's code in this thread.
 */
const job = workerData as PrepareJob;
parentPort?.postMessage(await answer(job));

function answer(job: PrepareJob): JobAnswer<unknown> | Promise<JobAnswer<unknown>> {
	if (job.kind === "read") return read(job.name, job.mediaType, job.data);
	if (job.kind === "chunk") return passagesOf(job.name, job.mediaType, job.text);
	if (job.kind === "parse-pdf") return parsePdf(job.data);
	return prepared(job.name, PDF_TYPE, storedText(job.pages));
}

/** The text as it is stored, and its passages from that stored text: the same as a later chunk of it gives. */
function read(name: string, mediaType: string, data: Uint8Array): JobAnswer<TextRead> {
	const result = readText(mediaType, data);
	if (result._tag === "Failure") return { failed: { tag: "TableTooLarge", reason: result.failure.reason } };
	const { pages, ...summary } = result.success;
	const text = prepared(name, mediaType, storedText(pages));
	return "failed" in text ? text : { ok: { read: summary, ...text.ok } };
}

/** A stored text, and its passages. */
function prepared(name: string, mediaType: string, text: string): JobAnswer<PreparedText> {
	const passages = passagesOf(name, mediaType, text);
	return "failed" in passages ? passages : { ok: { text, passages: passages.ok } };
}

/** The passages of a text that is not too long, if they are within the budget. */
function passagesOf(name: string, mediaType: string, text: string): JobAnswer<Passage[]> {
	if (text.length > MAX_TEXT_CHARS) return { failed: { tag: "DocumentTooLarge", reason: "text" } };
	const passages = chunkWithin({ name, pages: storedPages(mediaType, text), headings: headingRule(mediaType) }, PASSAGE_BUDGET);
	return passages === null ? { failed: { tag: "DocumentTooLarge", reason: "passages" } } : { ok: passages };
}
