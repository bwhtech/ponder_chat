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
import type { DocumentText } from "./document.ts";

/**
 * Reads a text document (read-document.ts) and splits a document's text into passages
 * (chunk.ts) in a worker thread (prepare-text-worker.ts), as pdf-text.ts reads a PDF. The
 * work grows with the input, and the size limits of csv.ts come first, but they can't
 * foresee every input: a CSV that is refused only once it is parsed, JSON nested deep, a
 * long PDF's text. On the server's own thread it would hold up every chat reply meanwhile.
 * A job that takes too long or too much memory is stopped, and the document fails.
 *
 * The worst text that the limits let through, a 10 MB CSV of short numbers, takes about
 * 2.5 seconds and 380 MB here: TIMEOUT and MAX_HEAP_MB leave it room on a slower server.
 */
const TIMEOUT = Duration.seconds(30);
const MAX_HEAP_MB = 512;
/** Each job can use a whole CPU core and MAX_HEAP_MB. The others wait their turn, in order. */
const MAX_JOBS_AT_ONCE = 2;
// The build swaps this address for the worker file that it makes (nitro.config.ts).
const WORKER = new URL("./prepare-text-worker.ts", import.meta.url);

/** How long a job may take, from its turn, and its worker's heap. Tests make them small. */
export type Limits = { readonly timeout: Duration.Input; readonly maxHeapMb: number };

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

/** A text document, read: what the log keeps, the text to store, and its passages. */
export type TextRead = { readonly read: Omit<DocumentText, "pages">; readonly text: string; readonly passages: Passage[] };

/** What a worker gets: a text document's bytes to read, or a stored text to split. */
export type PrepareJob =
	| { readonly kind: "read"; readonly name: string; readonly mediaType: string; readonly data: Uint8Array }
	| { readonly kind: "chunk"; readonly name: string; readonly mediaType: string; readonly text: string };

/** What it answers to a "read". A table too large is the person's to fix (csv.ts), so it comes back as its reason. */
export type ReadAnswer = { readonly read: TextRead } | { readonly refused: TableTooLarge["reason"] };

export class PrepareText extends Context.Service<
	PrepareText,
	{
		/** A text document (not a PDF): its text, and its passages, in one job. */
		readonly read: (document: { name: string; mediaType: string; data: Uint8Array }) => Effect.Effect<TextRead, PrepareTextError | TableTooLarge>;
		/** The passages of a stored text (storedText in read-document.ts). */
		readonly chunk: (document: { name: string; mediaType: string; text: string }) => Effect.Effect<Passage[], PrepareTextError>;
	}
>()("ponder/workspaces/PrepareText") {}

const make = (limits: Limits) =>
	Effect.gen(function* () {
		const turns = yield* Semaphore.make(MAX_JOBS_AT_ONCE);

		/** One job in a worker of its own, once it has its turn. The timeout counts from the turn. */
		const runJob = <A>(job: PrepareJob) =>
			Effect.gen(function* () {
				const waiting = yield* Clock.currentTimeMillis;
				return yield* turns.withPermit(
					Effect.gen(function* () {
						yield* Tracing.annotate({ "ponder.wait_ms": (yield* Clock.currentTimeMillis) - waiting });
						return yield* inWorker<A>(job, limits.maxHeapMb).pipe(
							Effect.timeoutOrElse({
								duration: limits.timeout,
								orElse: () => Effect.fail(new PrepareTextError({ reason: "timeout", seconds: Duration.toSeconds(limits.timeout) })),
							}),
						);
					}),
				);
			});

		const read = Effect.fn("PrepareText.read")(function* (document: { name: string; mediaType: string; data: Uint8Array }) {
			yield* Tracing.annotate({ "ponder.bytes": document.data.length });
			const answer = yield* runJob<ReadAnswer>({ kind: "read", ...document });
			if ("refused" in answer) return yield* new TableTooLarge({ reason: answer.refused });
			yield* Tracing.annotate({ "ponder.chars": answer.read.read.chars, "ponder.passages": answer.read.passages.length });
			return answer.read;
		});

		const chunk = Effect.fn("PrepareText.chunk")(function* (document: { name: string; mediaType: string; text: string }) {
			yield* Tracing.annotate({ "ponder.chars": document.text.length });
			const passages = yield* runJob<Passage[]>({ kind: "chunk", ...document });
			yield* Tracing.annotate({ "ponder.passages": passages.length });
			return passages;
		});

		return PrepareText.of({ read, chunk });
	});

export const layer = Layer.effect(PrepareText, make({ timeout: TIMEOUT, maxHeapMb: MAX_HEAP_MB }));

/** The service with other limits: for tests. */
export const layerWith = (limits: Limits) => Layer.effect(PrepareText, make(limits));

/** One worker for one job. It is stopped when the job ends, fails or is interrupted (a timeout). */
const inWorker = <A>(job: PrepareJob, maxHeapMb: number) =>
	Effect.acquireRelease(Effect.sync(() => startWorker<A>(job, maxHeapMb)), ({ worker }) => Effect.promise(() => worker.terminate())).pipe(
		Effect.flatMap(({ answer }) => Deferred.await(answer)),
		Effect.scoped,
	);

/** Starts the worker and listens to it at once, so no answer comes before the listeners. */
function startWorker<A>(job: PrepareJob, maxHeapMb: number) {
	// The bytes go as a copy, which the worker takes over. The caller keeps its buffer.
	const sent = job.kind === "read" ? { ...job, data: new Uint8Array(job.data) } : job;
	const worker = new Worker(WORKER, {
		workerData: sent,
		transferList: sent.kind === "read" ? [sent.data.buffer] : [],
		resourceLimits: { maxOldGenerationSizeMb: maxHeapMb, maxYoungGenerationSizeMb: 32 },
	});
	// Structured clone: plain data of the shape the worker posts (prepare-text-worker.ts).
	const answer = Deferred.makeUnsafe<A, PrepareTextError>();
	worker.once("message", (value: A) => Deferred.doneUnsafe(answer, Effect.succeed(value)));
	worker.once("error", (error) => Deferred.doneUnsafe(answer, Effect.fail(new PrepareTextError({ reason: outOfMemory(error) ? "memory" : "failed", cause: error }))));
	worker.once("exit", () => Deferred.doneUnsafe(answer, Effect.fail(new PrepareTextError({ reason: "stopped" }))));
	return { worker, answer };
}

/** Node stops a worker that reaches its resourceLimits with this error. */
function outOfMemory(error: unknown) {
	return (error as { code?: unknown } | null)?.code === "ERR_WORKER_OUT_OF_MEMORY";
}
