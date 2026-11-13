import { Worker } from "node:worker_threads";
import { span } from "./tracing/span.ts";

/**
 * The text of a PDF, read once on this server with pdf.js, so that a model that cannot
 * read PDFs gets plain text instead of the PDF being parsed again on every call.
 * A scanned PDF has little or no text layer: that gives "", and the model gets the PDF.
 *
 * pdf.js runs in a worker thread (pdf-text-worker.ts), never on the server's own thread:
 * a PDF of 2 KB can be made to take hours to read, and the server would answer nobody
 * meanwhile. A read that takes too long or too much memory is stopped and fails, and the
 * caller stores "" for it (files.ts), so the PDF is not read again.
 */
const TIMEOUT_MS = 20_000;
const MAX_HEAP_MB = 256;
const MAX_READS_AT_ONCE = 2;
// The build swaps this address for the worker file that it makes (nitro.config.ts).
const WORKER = new URL("./pdf-text-worker.ts", import.meta.url);

export async function extractPdfText(data: Buffer, timeoutMs = TIMEOUT_MS): Promise<string> {
	return span("pdf.extract_text", { "ponder.bytes": data.length }, async (active) => {
		const waiting = Date.now();
		await readers.take();
		active.setAttribute("ponder.wait_ms", Date.now() - waiting);
		try {
			const text = await readInWorker(data, timeoutMs);
			active.setAttribute("ponder.chars", text.length);
			return text;
		} finally {
			readers.release();
		}
	});
}

function readInWorker(data: Buffer, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		// A copy, which the worker takes over. The caller keeps its buffer.
		const bytes = new Uint8Array(data);
		const worker = new Worker(WORKER, {
			workerData: bytes,
			transferList: [bytes.buffer],
			resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, maxYoungGenerationSizeMb: 32 },
		});
		const finish = (settle: () => void) => {
			clearTimeout(timer);
			void worker.terminate();
			settle();
		};
		const timer = setTimeout(() => finish(() => reject(new Error(`reading took longer than ${timeoutMs / 1000} seconds`))), timeoutMs);
		worker.once("message", (text: string) => finish(() => resolve(text)));
		// Out of memory comes here too.
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", () => finish(() => reject(new Error("the reader stopped before it answered"))));
	});
}

/** Lets a fixed number of reads run at once; the others wait their turn. Each one can use a whole CPU core and MAX_HEAP_MB. */
class Slots {
	private waiting: (() => void)[] = [];

	constructor(private free: number) {}

	async take() {
		if (this.free > 0) this.free--;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
	}

	/** Hands the slot to the next one waiting, if any. */
	release() {
		const next = this.waiting.shift();
		if (next) next();
		else this.free++;
	}
}

const readers = new Slots(MAX_READS_AT_ONCE);
