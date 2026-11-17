import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage, UIMessageChunk } from "ai";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { isAuto } from "../../shared/auto-model.ts";
import * as PonderConfig from "../config.ts";
import * as Credits from "../credits/Credits.ts";
import * as Memory from "../memory.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Sandbox from "../python/pyodide.ts";
import * as PythonState from "../python/state.ts";
import { problem } from "../runtime/Database.ts";
import * as ModelCalls from "../telemetry/ModelCalls.ts";
import * as ThreadCache from "../thread-cache.ts";
import { isFirstMessage, nameThread } from "../thread-title.ts";
import * as Threads from "../threads/Threads.ts";
import { inReplyTrace, linkToReply, recordReplySpan, tracingOn } from "../tracing/reply-trace.ts";
import { answersIn, settledChunks, stillAsked, withUncertainOutcomes, type Answer } from "./answered-again.ts";
import * as ApprovalUses from "./approval-uses.ts";
import { messageIdFor, replyStream, saveReply } from "./reply.ts";
import * as ThreadRuns from "./runs.ts";
import type { Continued, ThreadRun } from "./runs.ts";
import * as WorkflowRuns from "./WorkflowRuns.ts";
import { atLeast } from "../workspaces/access.ts";
import * as Workspaces from "../workspaces/Workspaces.ts";

/**
 * A reply's whole life, for the routes (app.ts): start it, follow it, stop it, and delete
 * its thread. Each reply is a durable workflow run (chat.ts); runs.ts tracks each
 * thread's latest run.
 *
 * Every method takes the signed-in person and acts only on their thread, or on a new
 * thread id that nobody has taken. Starting, stopping and deleting take the thread's lock
 * (runs.ts), so a double submit or a second tab never leaves a run going that nobody
 * tracks and Stop can't reach.
 *
 * What runs inside a reply's trace (inReplyTrace) has no span of its own, so the spans in
 * it (reply.save, Workflow's) keep the reply's root as their parent, as before.
 */
export type Reply = { runId: string; stream: ReadableStream<UIMessageChunk> };
export type Started = Reply & {
	/** The same approval came twice, and this follows the run that carries it out, or carried it out. */
	followed: boolean;
};

/** The thread is someone else's. */
export class ThreadNotYours extends Schema.TaggedError<ThreadNotYours>()("ThreadNotYours", {
	threadId: Schema.String,
}) {
	override get message() {
		return `Thread ${this.threadId} is not the person's.`;
	}
}

/**
 * The person was removed from the chat's workspace, or can no longer use it. The chat is
 * still theirs to read, but not to send in. The message is the plain text the chat shows.
 */
export class WorkspaceAccessLost extends Schema.TaggedError<WorkspaceAccessLost>()("WorkspaceAccessLost", {
	threadId: Schema.String,
}) {
	override get message() {
		return "You no longer have access to this chat's workspace. You can read this chat, but not send in it.";
	}
}

/** No credits left today. The message is the plain text the chat shows. */
export class OutOfCredits extends Schema.TaggedError<OutOfCredits>()("OutOfCredits", {
	hours: Schema.Number,
}) {
	override get message() {
		return `You have used today's credits. They refill in about ${this.hours} hour${this.hours === 1 ? "" : "s"}.`;
	}
}

export type StartInput = {
	threadId: string;
	owner: string;
	messages: UIMessage[];
	model?: string;
	/** The workspace of a new chat. Read on its first message only: a chat's workspace never changes. */
	workspaceId?: string;
};

export class Replies extends Context.Service<
	Replies,
	{
		/**
		 * Saves the thread and starts a reply to it, when the person has credits left. A reply
		 * still running in the thread stops first, and keeps what it wrote. A new thread gets a
		 * name from a cheap model while the reply is written (thread-title.ts).
		 *
		 * After an approval, the page sends the thread again with no new message: the run then
		 * carries on the last assistant message. Each answer is used once: it must answer a
		 * question that still waits in the saved thread, and its use is recorded before the run
		 * starts (approval-uses.ts). An answer sent again, such as from a second tab, starts
		 * nothing and saves nothing: the page gets the outcome, and reloads the thread
		 * (answeredAgain).
		 *
		 * A chat in a workspace needs the person to be able to ask in it, on every message: a
		 * new chat fails with WorkspaceNotFound, a saved one with WorkspaceAccessLost.
		 */
		readonly start: (input: StartInput) => Effect.Effect<Started, OutOfCredits | ThreadNotYours | Workspaces.WorkspaceNotFound | WorkspaceAccessLost | SqlError>;
		/**
		 * The latest reply of a thread, by the thread id (a reloaded page) or the run id (a
		 * dropped connection), from `uiStartIndex` (the UI chunks the page has). A finished run
		 * replays to its end. None when there is no run, or it is not the person's.
		 */
		readonly follow: (id: string, owner: string, uiStartIndex?: number) => Effect.Effect<Option.Option<Reply>, SqlError>;
		/** Stops the thread's reply and saves what it wrote. False when no reply was running. */
		readonly stop: (threadId: string, owner: string) => Effect.Effect<boolean, SqlError>;
		/** Deletes the person's thread, after its reply stops. What the reply writes after this is not saved (reply.ts). */
		readonly remove: (threadId: string, owner: string) => Effect.Effect<boolean, SqlError>;
		/**
		 * Waits until the thread has no reply running, or `timeout` passes. The page sees the
		 * stream end a moment before the run's last step saves the reply.
		 */
		readonly whenFinished: (threadId: string, timeout?: number) => Effect.Effect<void, SqlError>;
		/**
		 * Finishes the runs that ended without saving their reply, so their thread does not look
		 * busy forever. chatTurn saves the reply on every way out of its own code, but the
		 * workflow runtime can fail a run outside it: a replay that diverged, such as a reply in
		 * flight across a deploy that changed its steps. Run by the sweep (sweep.ts).
		 *
		 * The reply is saved as far as it got: marked failed, so the page offers Retry, or
		 * cancelled, for a run that Stop cancelled and a crash kept from saving. The calls the run
		 * had in flight cost no credits, and the sweep gets their cost. One run that fails to
		 * finish does not keep the others waiting.
		 */
		readonly finishEndedRuns: Effect.Effect<void, SqlError>;
	}
>()("ponder/workflow/Replies") {}

/** The services of reply.ts and thread-title.ts, which the methods run on. */
type Uses = Threads.Threads | ThreadRuns.ThreadRuns | WorkflowRuns.WorkflowRuns | Memory.Memory | PonderConfig.PonderConfig | OpenRouterKey.OpenRouterKey | PgClient.PgClient;

/** What a page reads at the end of a reply whose run ended without saving it. */
const ENDED_ERROR = "This reply could not finish. Retry, or choose another model.";
const CANCEL_REASON = "Stopped by the person, or replaced by a newer message.";

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const threads = yield* Threads.Threads;
	const runs = yield* ThreadRuns.ThreadRuns;
	const uses = yield* ApprovalUses.ApprovalUses;
	const workflow = yield* WorkflowRuns.WorkflowRuns;
	const calls = yield* ModelCalls.ModelCalls;
	const credits = yield* Credits.Credits;
	const models = yield* Models.Models;
	const router = yield* AutoRouter.AutoRouter;
	const sandbox = yield* Sandbox.Sandbox;
	const cache = yield* ThreadCache.ThreadCache;
	const pythonStates = yield* PythonState.PythonState;
	const workspaces = yield* Workspaces.Workspaces;
	// Work that the request does not wait for (a thread's title) runs here, and stops with the runtime.
	const scope = yield* Effect.scope;
	// What the reply's save and stream (reply.ts) and the title (thread-title.ts) run on: these
	// services only, so the caller's own context (its span, the reply's trace) stays as it is.
	const services = Context.pick(
		Threads.Threads,
		ThreadRuns.ThreadRuns,
		WorkflowRuns.WorkflowRuns,
		Memory.Memory,
		PonderConfig.PonderConfig,
		OpenRouterKey.OpenRouterKey,
		PgClient.PgClient,
	)(yield* Effect.context<Uses>());
	const provided = <A, E>(effect: Effect.Effect<A, E, Uses>) => Effect.provideContext(effect, services);

	/** Whose thread this is, or none for a new one. */
	const ownerOf = (threadId: string) => threads.owner(threadId);
	/** The person's thread, or a thread id nobody has taken yet. */
	const mayUse = (threadId: string, owner: string) => Effect.map(ownerOf(threadId), (found) => Option.getOrElse(found, () => owner) === owner);

	/**
	 * The chat's workspace: the one a new chat's first message names, else the one the chat
	 * has. Checked on every message, so a person who was removed can no longer send. Under
	 * the thread's lock: two first messages sent at once both use the workspace that the
	 * first of them saved, never the one the second names.
	 */
	const workspaceFor = Effect.fnUntraced(function* (input: StartInput) {
		const isNew = Option.isNone(yield* ownerOf(input.threadId));
		const workspaceId = isNew ? input.workspaceId : Option.getOrUndefined(yield* threads.workspaceOf(input.threadId));
		if (!workspaceId) return undefined;
		if (atLeast(yield* workspaces.accessOf(input.owner, workspaceId), "ask")) return workspaceId;
		return yield* isNew ? new Workspaces.WorkspaceNotFound({ workspaceId }) : new WorkspaceAccessLost({ threadId: input.threadId });
	});

	/** Cancels a run and saves what it wrote so far, inside the run's trace (server/tracing/reply-trace.ts). */
	const cancel = (run: ThreadRun, owner: string) =>
		Effect.gen(function* () {
			// A failed cancel still saves the reply below, but the run may write on, so it is logged.
			yield* workflow
				.cancel(run.runId, CANCEL_REASON)
				.pipe(Effect.catchTags({ WorkflowFailed: (error) => Effect.logWarning(`replies: could not cancel run ${run.runId}:`, problem(error.cause)) }));
			// The step in flight writes on for a moment after a cancel, and the stream is never
			// closed, so the saved reply is what the run had written when it was stopped.
			// Finished even when the save fails, so the thread does not look busy forever.
			yield* andFinally(
				provided(saveReply(run.threadId, owner, run.runId, run.model, { cancelled: true, continued: run.continued })),
				Effect.gen(function* () {
					yield* runs.finish(run.threadId, run.runId, run.model, { cancelled: true, continued: run.continued });
					// The model call in flight runs to its end on OpenRouter; it costs the person no credits.
					yield* calls
						.stop(run.threadId, run.runId)
						.pipe(Effect.catchTags({ SqlError: (error) => Effect.logWarning(`replies: could not mark the calls of run ${run.runId} stopped:`, problem(error)) }));
				}),
			);
		}).pipe(inReplyTrace(run.runId));

	/**
	 * What the page gets for answers that were used already, or that answer no question
	 * waiting in the saved thread: no run starts, and nothing it sent is saved.
	 *
	 * An approved call whose run stopped or failed before its result (Stop, a crash) may or
	 * may not have taken effect. It never runs again: when no run is going, the saved thread
	 * says so in its place. The page gets each answer's outcome, so it does not send its
	 * answers again, and a signal to load the thread as it is saved (THREAD_CHANGED).
	 */
	const answeredAgain = Effect.fnUntraced(function* (threadId: string, owner: string, asked: UIMessage, answers: Answer[]) {
		yield* Effect.logWarning(`replies: thread ${threadId} answered approvals that were used already or are not asked; nothing runs`);
		let messages = yield* threads.load(threadId);
		if (Option.isNone(yield* runs.active(threadId))) {
			const at = messages.findIndex((message) => message.id === asked.id && message.role === "assistant");
			const settled = at === -1 ? undefined : withUncertainOutcomes(messages[at]!, answers);
			if (settled) {
				messages = messages.map((message, index) => (index === at ? settled : message));
				yield* threads.update(threadId, owner, messages);
			}
		}
		const saved = messages.find((message) => message.id === asked.id && message.role === "assistant");
		const latest = Option.getOrUndefined(yield* runs.latest(threadId));
		return { runId: latest?.runId ?? asked.id, model: latest?.model ?? "", followed: true, stream: chunkStream(settledChunks(saved, asked)) };
	});

	/** Under the thread's lock: the run that answers the thread, a new one or the one already going. */
	const startRun = Effect.fnUntraced(function* (input: StartInput, model: Models.ChatModel, python: boolean, requested: number) {
		const { threadId, owner, messages } = input;
		const workspaceId = yield* workspaceFor(input);
		const continued = continuedFrom(messages);
		const previous = Option.getOrUndefined(yield* runs.active(threadId));
		if (previous && sameContinuation(previous.continued, continued)) return { runId: previous.runId, model: previous.model, followed: true };
		// Before anything is stopped or saved: the stale page's thread must not replace the saved one.
		const asked = continued ? messages.at(-1)! : undefined;
		const answers = asked ? answersIn(asked) : [];
		if (asked && answers.length) {
			const saved = (yield* threads.load(threadId)).find((message) => message.id === asked.id && message.role === "assistant");
			if (!stillAsked(saved, answers) || !(yield* uses.use(threadId, answers))) return yield* answeredAgain(threadId, owner, asked, answers);
		}
		if (previous) yield* cancel(previous, owner);
		// A continued run is a trace of its own that links to the run it carries on (server/tracing/reply-trace.ts).
		const carriesOn = continued && tracingOn() ? Option.getOrUndefined(yield* runs.latest(threadId))?.runId : undefined;
		const runId = yield* Effect.gen(function* () {
			// The run reads the thread from the database, so it is saved first.
			yield* threads.save(threadId, owner, messages, workspaceId);
			// Under Auto, a reply carried on after an approval goes back to the model that wrote it.
			const answeredBy = continued && isAuto(model.id) ? Option.getOrUndefined(yield* router.lastAnsweringModel(threadId)) : undefined;
			// Set here, so the prompt does not read the clock inside the workflow (chat.ts).
			const today = new Date(yield* Clock.currentTimeMillis).toDateString();
			return yield* workflow.start({
				threadId,
				owner,
				model: { id: model.id, name: model.name },
				python,
				today,
				maxSteps: config.maxSteps,
				continued,
				answeredBy,
				workspaceId,
			});
		}).pipe(
			// No run carries the answers out, so the page may send them again. The start's own
			// failure is the one the route answers; a release that fails too changes nothing for it.
			Effect.onError(() => (answers.length ? Effect.ignore(uses.release(threadId, answers)) : Effect.void)),
		);
		if (answers.length) yield* uses.usedBy(threadId, answers, runId);
		yield* runs.setActive(threadId, runId, model.id, continued);
		const now = yield* Clock.currentTimeMillis;
		recordReplySpan(runId, "chat.request", requested, now, { "ponder.continued": Boolean(continued) }, carriesOn ? [linkToReply(carriesOn)] : []);
		return { runId, model: model.id, followed: false };
	});

	/**
	 * The page shows a question as soon as the run that asked it ends its stream, but the run
	 * saves its reply a step later (chat.ts). An answer can come in between, and the saved
	 * thread then has no question for it: it would read as answered already, run nothing,
	 * and the page would load the thread and show the question again. So an answer to the
	 * active run's own message waits for that run to save, up to 10 seconds (whenFinished).
	 * Not under the thread's lock: the save does not take it, and Stop must not wait.
	 */
	const untilQuestionSaved = Effect.fnUntraced(function* (threadId: string, messages: UIMessage[], continued: Continued | null) {
		const asked = continued ? messages.at(-1) : undefined;
		const answers = asked ? answersIn(asked) : [];
		const running = Option.getOrUndefined(yield* runs.active(threadId));
		if (!asked || !answers.length || !running) return;
		if (sameContinuation(running.continued, continued)) return;
		if ((running.continued?.messageId ?? messageIdFor(running.runId)) !== asked.id) return;
		const saved = (yield* threads.load(threadId)).find((message) => message.id === asked.id && message.role === "assistant");
		if (!stillAsked(saved, answers)) yield* whenFinished(threadId);
	});

	const start = Effect.fn("Replies.start")(function* (input: StartInput) {
		const { threadId, owner, messages } = input;
		const checking = yield* Clock.currentTimeMillis;
		const status = yield* credits.status(owner);
		const checked = yield* Clock.currentTimeMillis;
		if (status.remaining <= 0) return yield* new OutOfCredits({ hours: Math.max(1, Math.ceil((new Date(status.resetsAt).getTime() - checked) / 3_600_000)) });
		const savedOwner = yield* ownerOf(threadId);
		if (Option.getOrElse(savedOwner, () => owner) !== owner) return yield* new ThreadNotYours({ threadId });
		const model = yield* models.pick(input.model);
		const python = yield* sandbox.ready;
		const continued = continuedFrom(messages);
		yield* untilQuestionSaved(threadId, messages, continued);
		const started = yield* runs.withLock(threadId, startRun(input, model, python, checked));
		// The run goes on if the request closes; the page reconnects with follow.
		const stream = "stream" in started ? started.stream : yield* provided(replyStream(started.runId, started.model, { continued })).pipe(inReplyTrace(started.runId));
		if (!started.followed) {
			// Measured before the run had an id, so recorded into its trace now (server/tracing/reply-trace.ts).
			recordReplySpan(started.runId, "credits.check", checking, checked);
			// A new thread gets a name from a cheap model while the reply is written. It never fails.
			if (isFirstMessage(messages)) yield* provided(nameThread({ threadId, user: owner }, messages)).pipe(inReplyTrace(started.runId), Effect.forkIn(scope));
		}
		return { runId: started.runId, followed: started.followed, stream } satisfies Started;
	});

	const follow = Effect.fn("Replies.follow")(function* (id: string, owner: string, uiStartIndex = 0) {
		const run = Option.getOrUndefined(yield* runs.latest(id));
		if (!run || !(yield* mayUse(run.threadId, owner))) return Option.none<Reply>();
		const stream = yield* provided(replyStream(run.runId, run.model, { uiStartIndex, untilTail: run.cancelled || run.failed, continued: run.continued })).pipe(inReplyTrace(run.runId));
		return Option.some<Reply>({ runId: run.runId, stream });
	});

	const stop = Effect.fn("Replies.stop")(function* (threadId: string, owner: string) {
		if (!(yield* mayUse(threadId, owner))) return false;
		return yield* runs.withLock(
			threadId,
			Effect.gen(function* () {
				const run = Option.getOrUndefined(yield* runs.active(threadId));
				if (run) yield* cancel(run, owner);
				return Boolean(run);
			}),
		);
	});

	const remove = Effect.fn("Replies.remove")(function* (threadId: string, owner: string) {
		const deleted = yield* runs.withLock(
			threadId,
			Effect.gen(function* () {
				if (Option.getOrUndefined(yield* ownerOf(threadId)) !== owner) return false;
				const run = Option.getOrUndefined(yield* runs.active(threadId));
				if (run) yield* cancel(run, owner);
				if (!(yield* threads.remove(threadId, owner))) return false;
				yield* runs.forget(threadId);
				yield* uses.forget(threadId);
				return true;
			}),
		);
		if (deleted) {
			yield* cache.forget(threadId);
			yield* pythonStates.forget(threadId, owner);
		}
		return deleted;
	});

	const whenFinished = Effect.fn("Replies.whenFinished")(function* (threadId: string, timeout = 10_000) {
		yield* runs.active(threadId).pipe(Effect.repeat({ while: Option.isSome, schedule: Schedule.spaced("250 millis") }), Effect.timeoutOption(timeout));
	});

	const finishEndedRun = Effect.fnUntraced(function* (run: ThreadRun) {
		const status = yield* workflow.status(run.runId);
		if (status === "pending" || status === "running") return;
		const cancelled = status === "cancelled";
		const failed = !cancelled && status !== "completed";
		// Inside the run's trace, so the reply.save span has its parent (server/tracing/reply-trace.ts).
		yield* runs.withLock(
			run.threadId,
			Effect.gen(function* () {
				if (Option.getOrUndefined(yield* runs.active(run.threadId))?.runId !== run.runId) return;
				yield* Effect.logWarning(`replies: run ${run.runId} ended (${status}) without saving its reply; saving what it wrote`);
				// Finished even when the save fails, so the thread does not look busy forever.
				yield* andFinally(
					Effect.gen(function* () {
						if (cancelled) yield* calls.stop(run.threadId, run.runId);
						else yield* calls.settle(run.threadId, run.runId);
						// Before the save, as chatTurn does (endReplyStream), so the saved reply ends where the page's does.
						yield* endStream(run.runId, failed ? ENDED_ERROR : undefined);
						const owner = Option.getOrUndefined(yield* ownerOf(run.threadId));
						if (owner) yield* provided(saveReply(run.threadId, owner, run.runId, run.model, { cancelled, failed, continued: run.continued }));
					}),
					runs.finish(run.threadId, run.runId, run.model, { cancelled, failed, continued: run.continued }),
				);
			}).pipe(inReplyTrace(run.runId)),
		);
	});

	/**
	 * Ends the stream of a run that ended without ending it, as endReplyStream does in the
	 * run: with the error for a failed run. A page that still follows the reply, such as one
	 * open during a deploy, then stops and offers Retry without a reload. A run the runtime
	 * no longer has, or a stream it refuses, is logged: the reply is saved either way.
	 */
	const endStream = (runId: string, error?: string) =>
		workflow.endStream(runId, error).pipe(Effect.catchTags({ WorkflowFailed: (failure) => Effect.logWarning(`replies: could not end the stream of run ${runId}:`, problem(failure.cause)) }));

	const finishEndedRuns = Effect.gen(function* () {
		for (const run of yield* runs.unfinished) {
			yield* finishEndedRun(run).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError(`replies: could not finish run ${run.runId}:`, problem(Cause.squash(cause))),
				),
			);
		}
	}).pipe(Effect.withSpan("Replies.finishEndedRuns"));

	return Replies.of({ start, follow, stop, remove, whenFinished, finishEndedRuns });
});

export const layer = Layer.effect(Replies, make);

/**
 * As try/finally: `after` runs when `work` succeeds or fails, and a failure of `after`
 * wins, as a throw from a finally block does. Not when `work` is interrupted (SIGTERM
 * disposing the runtime): the run then stays unfinished, as it did when the old process
 * stopped in the middle, so the sweep at the next start saves its reply and finishes it.
 */
function andFinally<A, E, R, E2, R2>(work: Effect.Effect<A, E, R>, after: Effect.Effect<unknown, E2, R2>): Effect.Effect<A, E | E2, R | R2> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.flatMap(Effect.exit(restore(work)), (exit) => (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? exit : Effect.andThen(after, exit))),
	);
}

function chunkStream(chunks: UIMessageChunk[]) {
	return new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

/** A thread that ends on an assistant message carries on that message (an approval was answered). */
function continuedFrom(messages: UIMessage[]): Continued | null {
	const last = messages.at(-1);
	return last?.role === "assistant" ? { messageId: last.id, baseParts: last.parts.length } : null;
}

function sameContinuation(running: Continued | null, asked: Continued | null) {
	return Boolean(asked && running?.messageId === asked.messageId && running.baseParts === asked.baseParts);
}
