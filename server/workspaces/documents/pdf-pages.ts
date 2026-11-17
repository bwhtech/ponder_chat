import { Worker } from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Copies single pages out of a PDF, so that each page can go to a model on its own.
 * pdf.js does it in a worker thread (pdf-pages-worker.ts), as pdf-text.ts reads text:
 * a PDF can be made to take hours, and the server's own thread must keep answering.
 */
const TIMEOUT = Duration.seconds(60);
const MAX_HEAP_MB = 512;
// The build swaps this address for the worker file that it makes (nitro.config.ts).
const WORKER = new URL("./pdf-pages-worker.ts", import.meta.url);

/** The pages could not be copied: it took too long, pdf.js failed, or the worker stopped. */
export class PdfPagesFailed extends Schema.TaggedError<PdfPagesFailed>()("PdfPagesFailed", {
	reason: Schema.Literals(["timeout", "failed", "stopped"]),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		if (this.reason === "timeout") return `copying pages took longer than ${Duration.toSeconds(TIMEOUT)} seconds`;
		if (this.reason === "stopped") return "the page copier stopped before it answered";
		return "pdf.js could not copy the pages";
	}
}

/** A one-page PDF for each page number (counted from 1), in the same order. */
export const onePagePdfs = (data: Uint8Array, pages: ReadonlyArray<number>): Effect.Effect<Uint8Array[], PdfPagesFailed> =>
	pages.length === 0
		? Effect.succeed([])
		: copyInWorker(data, [...pages]).pipe(
				Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new PdfPagesFailed({ reason: "timeout" })) }),
			);

/** One worker for one copy. It is stopped when the copy ends, fails or is interrupted (a timeout). */
const copyInWorker = (data: Uint8Array, pages: number[]) =>
	Effect.acquireRelease(Effect.sync(() => startWorker(data, pages)), ({ worker }) => Effect.promise(() => worker.terminate())).pipe(
		Effect.flatMap(({ answer }) => Deferred.await(answer)),
		Effect.scoped,
	);

/** Starts the worker and listens to it at once, so no answer comes before the listeners. */
function startWorker(data: Uint8Array, pages: number[]) {
	// A copy, which the worker takes over. The caller keeps its buffer.
	const bytes = new Uint8Array(data);
	const worker = new Worker(WORKER, {
		workerData: { data: bytes, pages },
		transferList: [bytes.buffer],
		resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, maxYoungGenerationSizeMb: 32 },
	});
	const answer = Deferred.makeUnsafe<Uint8Array[], PdfPagesFailed>();
	worker.once("message", (copies: Uint8Array[]) => Deferred.doneUnsafe(answer, Effect.succeed(copies)));
	// Out of memory comes here too.
	worker.once("error", (error) => Deferred.doneUnsafe(answer, Effect.fail(new PdfPagesFailed({ reason: "failed", cause: error }))));
	worker.once("exit", () => Deferred.doneUnsafe(answer, Effect.fail(new PdfPagesFailed({ reason: "stopped" }))));
	return { worker, answer };
}
