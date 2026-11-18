import { Worker } from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracing from "./tracing/Tracing.ts";

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
const TIMEOUT = Duration.seconds(20);
const MAX_HEAP_MB = 256;
/** Each read can use a whole CPU core and MAX_HEAP_MB. The others wait their turn, in order. */
const MAX_READS_AT_ONCE = 2;
// The build swaps this address for the worker file that it makes (nitro.config.ts).
const WORKER = new URL("./pdf-text-worker.ts", import.meta.url);

/**
 * A read that did not give text: it took too long, pdf.js failed (out of memory comes
 * here too; the cause is pdf.js's error), the text was too long to keep, or the worker
 * stopped before it answered.
 */
export class PdfTextError extends Schema.TaggedError<PdfTextError>()("PdfTextError", {
	reason: Schema.Literals(["timeout", "failed", "too-large", "stopped"]),
	seconds: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		if (this.reason === "timeout") return `reading took longer than ${this.seconds} seconds`;
		if (this.reason === "stopped") return "the reader stopped before it answered";
		if (this.reason === "too-large") return "the PDF has too much text to keep";
		return "pdf.js could not read the PDF";
	}
}

export class PdfText extends Context.Service<
	PdfText,
	{
		/** The PDF's text, or "" for a scan. At most MAX_READS_AT_ONCE at once; the timeout counts from the read's turn. */
		readonly extract: (data: Buffer, timeout?: Duration.Input) => Effect.Effect<string, PdfTextError>;
	}
>()("ponder/files/PdfText") {}

const make = Effect.gen(function* () {
	const readers = yield* Semaphore.make(MAX_READS_AT_ONCE);

	const extract = Effect.fn("pdf.extract_text")(function* (data: Buffer, timeout: Duration.Input = TIMEOUT) {
		yield* Tracing.annotate({ "ponder.bytes": data.length });
		const waiting = yield* Clock.currentTimeMillis;
		return yield* readers.withPermit(
			Effect.gen(function* () {
				yield* Tracing.annotate({ "ponder.wait_ms": (yield* Clock.currentTimeMillis) - waiting });
				const text = yield* readInWorker(data).pipe(
					Effect.timeoutOrElse({
						duration: timeout,
						orElse: () => Effect.fail(new PdfTextError({ reason: "timeout", seconds: Duration.toSeconds(timeout) })),
					}),
				);
				yield* Tracing.annotate({ "ponder.chars": text.length });
				return text;
			}),
		);
	});

	return PdfText.of({ extract });
});

export const layer = Layer.effect(PdfText, make);

/** One worker for one read. It is stopped when the read ends, fails or is interrupted (a timeout). */
const readInWorker = (data: Buffer) =>
	Effect.acquireRelease(Effect.sync(() => startWorker(data)), ({ worker }) => Effect.promise(() => worker.terminate())).pipe(
		Effect.flatMap(({ answer }) => Deferred.await(answer)),
		Effect.scoped,
	);

/** Starts the worker and listens to it at once, so no answer comes before the listeners. */
function startWorker(data: Buffer) {
	// A copy, which the worker takes over. The caller keeps its buffer.
	const bytes = new Uint8Array(data);
	const worker = new Worker(WORKER, {
		workerData: bytes,
		transferList: [bytes.buffer],
		resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, maxYoungGenerationSizeMb: 32 },
	});
	const answer = Deferred.makeUnsafe<string, PdfTextError>();
	// Null when the text was past the worker's limit (pdf-text-worker.ts).
	worker.once("message", (text: string | null) => Deferred.doneUnsafe(answer, text === null ? Effect.fail(new PdfTextError({ reason: "too-large" })) : Effect.succeed(text)));
	// Out of memory comes here too.
	worker.once("error", (error) => Deferred.doneUnsafe(answer, Effect.fail(new PdfTextError({ reason: "failed", cause: error }))));
	worker.once("exit", () => Deferred.doneUnsafe(answer, Effect.fail(new PdfTextError({ reason: "stopped" }))));
	return { worker, answer };
}
