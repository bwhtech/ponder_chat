import { Worker } from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracing from "../../tracing/Tracing.ts";
import type { Passage } from "./chunk.ts";
import { TableTooLarge } from "./csv.ts";
import { PdfUnreadable, type DocumentPage, type DocumentText } from "./document.ts";
import { DocumentTooLarge } from "./limits.ts";
import type { ParsedPdf } from "./parse-pdf.ts";
import type { PrepareJob } from "./prepare-job.ts";

/**
 * Reads documents and splits their text into passages in a worker thread
 * (prepare-text-worker.ts), as pdf-text.ts reads a PDF for a chat. The work grows with
 * the input, and the size limits of csv.ts come first, but they can't foresee every
 * input: a CSV that is refused only once it is parsed, JSON nested deep, a PDF whose
 * small file holds a great deal of text. On the server's own thread it would hold up
 * every chat reply meanwhile. A job that takes too long or too much memory is stopped,
 * and the document fails.
 *
 * The worker answers only within the limits of limits.ts: the server's thread copies its
 * answer whole before it can look at it, and a large one would hold that thread up too.
 *
 * The worst text that the limits let through, a 10 MB CSV of short numbers, takes about
 * 2.5 seconds and 380 MB here: TIMEOUT and MAX_HEAP_MB leave it room on a slower server.
 * LiteParse read the 398-page manual in 2.5 seconds: PDF_TIMEOUT is its own timeout of before.
 */
const TIMEOUT = Duration.seconds(30);
const PDF_TIMEOUT = Duration.minutes(2);
const MAX_HEAP_MB = 512;
/** Each job can use a whole CPU core and MAX_HEAP_MB. The others wait their turn, in order. */
const MAX_JOBS_AT_ONCE = 2;
// The build swaps this address for the worker file that it makes (nitro.config.ts).
const WORKER = new URL("./prepare-text-worker.ts", import.meta.url);

/** How long a job may take, from its turn (reading a PDF: `pdfTimeout`), and its worker's heap. Tests make them small. */
export type Limits = { readonly timeout: Duration.Input; readonly pdfTimeout: Duration.Input; readonly maxHeapMb: number };

/**
 * A job that did not finish: it took too long, ran out of memory, threw, or the worker
 * stopped before it answered. The message is what the person reads on the document.
 */
export class PrepareTextError extends Schema.TaggedError<PrepareTextError>()("PrepareTextError", {
	reason: Schema.Literals(["timeout", "memory", "failed", "stopped"]),
	seconds: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		if (this.reason === "timeout") return `Reading the document timed out after ${this.seconds} seconds.`;
		if (this.reason === "memory") return "The document is too large or complex to read.";
		if (this.reason === "stopped") return "The reader stopped before it answered.";
		return "The document could not be read.";
	}
}

/** What a job can fail with: the worker's own failure, or a reason that the document gives. */
export type PrepareError = PrepareTextError | TableTooLarge | DocumentTooLarge | PdfUnreadable;

/** A text to store, and its passages. */
export type PreparedText = { readonly text: string; readonly passages: Passage[] };
/** A text document, read: what the log keeps, the text to store, and its passages. */
export type TextRead = PreparedText & { readonly read: Omit<DocumentText, "pages"> };

/** Why a job gave no answer, as plain data: errors are classes, which a worker can't post. */
export type JobFailure =
	| { readonly tag: "TableTooLarge"; readonly reason: TableTooLarge["reason"] }
	| { readonly tag: "DocumentTooLarge"; readonly reason: DocumentTooLarge["reason"] }
	| { readonly tag: "PdfUnreadable"; readonly reason: PdfUnreadable["reason"]; readonly cause?: unknown };
export type JobAnswer<A> = { readonly ok: A } | { readonly failed: JobFailure };

export class PrepareText extends Context.Service<
	PrepareText,
	{
		/** A text document (not a PDF): its text, and its passages, in one job. */
		readonly read: (document: { name: string; mediaType: string; data: Uint8Array }) => Effect.Effect<TextRead, PrepareError>;
		/** The passages of a stored text (storedText in read-document.ts). */
		readonly chunk: (document: { name: string; mediaType: string; text: string }) => Effect.Effect<Passage[], PrepareError>;
		/** A PDF's pages, as LiteParse or pdf.js read them, with the repeated lines dropped. */
		readonly parsePdf: (data: Uint8Array) => Effect.Effect<ParsedPdf, PrepareError>;
		/** A PDF's stored text and passages, from its pages once a model read the picture pages. */
		readonly preparePdf: (document: { name: string; pages: ReadonlyArray<DocumentPage> }) => Effect.Effect<PreparedText, PrepareError>;
	}
>()("ponder/workspaces/PrepareText") {}

const make = (limits: Limits) =>
	Effect.gen(function* () {
		const turns = yield* Semaphore.make(MAX_JOBS_AT_ONCE);

		/** One job in a worker of its own, once it has its turn. The timeout counts from the turn. */
		const runJob = <A>(job: PrepareJob) =>
			Effect.gen(function* () {
				const waiting = yield* Clock.currentTimeMillis;
				const timeout = job.kind === "parse-pdf" ? limits.pdfTimeout : limits.timeout;
				const answer = yield* turns.withPermit(
					Effect.gen(function* () {
						yield* Tracing.annotate({ "ponder.wait_ms": (yield* Clock.currentTimeMillis) - waiting });
						return yield* inWorker<A>(job, limits.maxHeapMb).pipe(
							Effect.timeoutOrElse({
								duration: timeout,
								orElse: () => Effect.fail(new PrepareTextError({ reason: "timeout", seconds: Duration.toSeconds(timeout) })),
							}),
						);
					}),
				);
				return "failed" in answer ? yield* Effect.fail(jobError(answer.failed)) : answer.ok;
			});

		const read = Effect.fn("PrepareText.read")(function* (document: { name: string; mediaType: string; data: Uint8Array }) {
			yield* Tracing.annotate({ "ponder.bytes": document.data.length });
			const read = yield* runJob<TextRead>({ kind: "read", ...document });
			yield* Tracing.annotate({ "ponder.chars": read.read.chars, "ponder.passages": read.passages.length });
			return read;
		});

		const chunk = Effect.fn("PrepareText.chunk")(function* (document: { name: string; mediaType: string; text: string }) {
			yield* Tracing.annotate({ "ponder.chars": document.text.length });
			const passages = yield* runJob<Passage[]>({ kind: "chunk", ...document });
			yield* Tracing.annotate({ "ponder.passages": passages.length });
			return passages;
		});

		const parsePdf = Effect.fn("PrepareText.parsePdf")(function* (data: Uint8Array) {
			yield* Tracing.annotate({ "ponder.bytes": data.length });
			const parsed = yield* runJob<ParsedPdf>({ kind: "parse-pdf", data });
			yield* Tracing.annotate({ "ponder.pages": parsed.pageCount });
			return parsed;
		});

		const preparePdf = Effect.fn("PrepareText.preparePdf")(function* (document: { name: string; pages: ReadonlyArray<DocumentPage> }) {
			const prepared = yield* runJob<PreparedText>({ kind: "pdf", ...document });
			yield* Tracing.annotate({ "ponder.chars": prepared.text.length, "ponder.passages": prepared.passages.length });
			return prepared;
		});

		return PrepareText.of({ read, chunk, parsePdf, preparePdf });
	});

export const layer = Layer.effect(PrepareText, make({ timeout: TIMEOUT, pdfTimeout: PDF_TIMEOUT, maxHeapMb: MAX_HEAP_MB }));

/** The service with some other limits: for tests. */
export const layerWith = (limits: Partial<Limits>) => Layer.effect(PrepareText, make({ timeout: TIMEOUT, pdfTimeout: PDF_TIMEOUT, maxHeapMb: MAX_HEAP_MB, ...limits }));

function jobError(failure: JobFailure): PrepareError {
	if (failure.tag === "TableTooLarge") return new TableTooLarge({ reason: failure.reason });
	if (failure.tag === "DocumentTooLarge") return new DocumentTooLarge({ reason: failure.reason });
	return new PdfUnreadable({ reason: failure.reason, cause: failure.cause });
}

/** One worker for one job. It is stopped when the job ends, fails or is interrupted (a timeout). */
const inWorker = <A>(job: PrepareJob, maxHeapMb: number) =>
	Effect.acquireRelease(Effect.sync(() => startWorker<A>(job, maxHeapMb)), ({ worker }) => Effect.promise(() => worker.terminate())).pipe(
		Effect.flatMap(({ answer }) => Deferred.await(answer)),
		Effect.scoped,
	);

/** Starts the worker and listens to it at once, so no answer comes before the listeners. */
function startWorker<A>(job: PrepareJob, maxHeapMb: number) {
	// Bytes go as a copy, which the worker takes over. The caller keeps its buffer.
	const sent = "data" in job ? { ...job, data: new Uint8Array(job.data) } : job;
	const worker = new Worker(WORKER, {
		workerData: sent,
		transferList: "data" in sent ? [sent.data.buffer] : [],
		resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 32 },
	});
	// Structured clone: plain data of the shape the worker posts (prepare-text-worker.ts).
	const answer = Deferred.makeUnsafe<JobAnswer<A>, PrepareTextError>();
	// The worker's own answer to this job: the job's kind decides its type (prepare-text-worker.ts).
	worker.once("message", (value: unknown) => Deferred.doneUnsafe(answer, Effect.succeed(value as JobAnswer<A>)));
	worker.once("error", (error) => Deferred.doneUnsafe(answer, Effect.fail(new PrepareTextError({ reason: outOfMemory(error) ? "memory" : "failed", cause: error }))));
	worker.once("exit", () => Deferred.doneUnsafe(answer, Effect.fail(new PrepareTextError({ reason: "stopped" }))));
	return { worker, answer };
}

/** Node stops a worker that reaches its resourceLimits with this error. */
function outOfMemory(error: unknown) {
	return (error as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY";
}
