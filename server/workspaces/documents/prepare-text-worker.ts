import { parentPort, workerData } from "node:worker_threads";
import { chunkDocument, type Passage } from "./chunk.ts";
import type { PrepareJob, ReadAnswer } from "./prepare-text.ts";
import { headingRule, readText, storedPages, storedText } from "./read-document.ts";

/**
 * The worker thread that reads a text document and splits a text into passages
 * (prepare-text.ts starts it, and stops it when it takes too long). It gets one job and
 * posts one answer.
 *
 * It imports only the pure modules of reading and chunking, and Effect's data types. The
 * build makes it a file of its own (nitro.config.ts), and a module of the server would run
 * the server's code in this thread.
 */
const job = workerData as PrepareJob;
parentPort?.postMessage(job.kind === "read" ? read(job.name, job.mediaType, job.data) : passages(job.name, job.mediaType, job.text));

/** The text as it is stored, and its passages from that stored text: the same as a later chunk of it gives. */
function read(name: string, mediaType: string, data: Uint8Array): ReadAnswer {
	const result = readText(mediaType, data);
	if (result._tag === "Failure") return { refused: result.failure.reason };
	const { pages, ...summary } = result.success;
	const text = storedText(pages);
	return { read: { read: summary, text, passages: passages(name, mediaType, text) } };
}

function passages(name: string, mediaType: string, text: string): Passage[] {
	return chunkDocument({ name, pages: storedPages(mediaType, text), headings: headingRule(mediaType) });
}
