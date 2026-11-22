/**
 * A reply's start, Stop and delete when they race (replies.ts): the thread's lock keeps
 * one run tracked, and Stop reaching it once. On a real Postgres (TEST_DATABASE_URL,
 * vitest.config.ts), in a schema of its own, which the last test drops. Workflow's runtime
 * is the fake: it hands out run ids, and records each cancel. The rest is the app's layer,
 * with memory, Python and OpenRouter off.
 */
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { WorkflowReadableStream } from "workflow/api";
import type { RunStatus } from "./WorkflowRuns.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_replies_${tag}`;
const base = process.env.TEST_DATABASE_URL;

// The app's layer reads the process's environment when it is built (config.ts).
if (base) {
	Object.assign(process.env, {
		DATABASE_URL: `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`,
		BETTER_AUTH_SECRET: "test-secret-for-the-replies-0123456789abcdef",
		PONDER_MEMORY: "off",
		PONDER_PYTHON: "off",
		OPENROUTER_API_KEY: "sk-or-v1-test",
		// Nothing answers here: the title and the models list fail at once, and are logged.
		OPENROUTER_BASE_URL: "http://127.0.0.1:9/api",
	});
}

const AppLayer = await import("../runtime/layer.ts");
const Replies = await import("./replies.ts");
const ThreadRuns = await import("./runs.ts");
const WorkflowRuns = await import("./WorkflowRuns.ts");
const Threads = await import("../threads/Threads.ts");
const Sandbox = await import("../python/pyodide.ts");

/**
 * Workflow's runtime: run ids in the order the runs start (ULIDs sort so), the runs it was
 * asked to cancel, a status per run ("running" when not set), and the runs whose stream
 * never ends, with a signal when one is read.
 */
const workflow = { started: [] as string[], cancelled: [] as string[], status: new Map<string, RunStatus>(), endless: new Map<string, Deferred.Deferred<void>>() };
const emptyStream = () => Object.assign(new ReadableStream<ModelCallStreamPart>({ start: (controller) => controller.close() }), { getTailIndex: async () => -1 }) as WorkflowReadableStream<ModelCallStreamPart>;
const endlessStream = () => Object.assign(new ReadableStream<ModelCallStreamPart>(), { getTailIndex: async () => 0 }) as WorkflowReadableStream<ModelCallStreamPart>;
const fakeWorkflow = Layer.succeed(
	WorkflowRuns.WorkflowRuns,
	WorkflowRuns.WorkflowRuns.of({
		start: () =>
			Effect.sync(() => {
				const runId = `wrun_01KTEST${tag.toUpperCase().padEnd(8, "0")}${String(workflow.started.length).padStart(10, "0")}`;
				workflow.started.push(runId);
				return runId;
			}),
		status: (runId) => Effect.succeed(workflow.status.get(runId) ?? "running"),
		cancel: (runId) => Effect.sync(() => void workflow.cancelled.push(runId)),
		readable: (runId) =>
			Effect.sync(() => {
				const reading = workflow.endless.get(runId);
				if (!reading) return emptyStream();
				Deferred.doneUnsafe(reading, Exit.void);
				return endlessStream();
			}),
		endStream: () => Effect.void,
	}),
);

const layer = AppLayer.layer;
/** Replies on the fake Workflow, the rest from the app's layer: a fresh one, since the app's layer has its own. One for each test, so its runs share one lock. */
const onFakeWorkflow = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, Layer.fresh(Replies.layer).pipe(Layer.provide(fakeWorkflow)));

const owner = `test-owner-${tag}`;
const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe.skipIf(!base)("replies that race", () => {
	afterAll(() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`drop schema if exists ${schema} cascade`);
			}).pipe(Effect.provide(layer)),
		),
	);

	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("makes the tables", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* ThreadRuns.ThreadRuns.use((runs) => runs.migrate);
				const Runs = yield* Effect.promise(() => import("../telemetry/Runs.ts"));
				const Credits = yield* Effect.promise(() => import("../credits/Credits.ts"));
				const Settings = yield* Effect.promise(() => import("../settings/Settings.ts"));
				const ApprovalUses = yield* Effect.promise(() => import("./approval-uses.ts"));
				const PythonState = yield* Effect.promise(() => import("../python/state.ts"));
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Settings.Settings.use((settings) => settings.migrate);
				yield* Credits.Credits.use((credits) => credits.migrate);
				yield* ApprovalUses.ApprovalUses.use((uses) => uses.migrate);
				yield* PythonState.PythonState.use((states) => states.migrate);
				yield* Sandbox.Sandbox.use((sandbox) => sandbox.turnOff);
			}),
		);

		it.effect("a double submit leaves one run tracked: the second stops the first", () =>
			Effect.gen(function* () {
				const threadId = `thread-double-${tag}`;
				const replies = yield* Replies.Replies;
				const first = workflow.started.length;
				const [a, b] = yield* Effect.all(
					[replies.start({ threadId, owner, messages: [message("m1", "Hello")] }), replies.start({ threadId, owner, messages: [message("m1", "Hello")] })],
					{ concurrency: "unbounded" },
				);
				const [one, two] = workflow.started.slice(first);
				assert.deepStrictEqual([a.runId, b.runId].sort(), [one, two]);
				assert.deepStrictEqual(workflow.cancelled.slice(-1), [one]);
				const latest = Option.getOrThrow(yield* ThreadRuns.ThreadRuns.use((runs) => runs.latest(threadId)));
				assert.strictEqual(latest.runId, two);
				assert.isFalse(latest.finished);
			}).pipe(onFakeWorkflow),
		);

		it.effect("an answer that comes before the run saved its question waits for the save, and starts a run", () =>
			Effect.gen(function* () {
				const threadId = `thread-early-answer-${tag}`;
				const replies = yield* Replies.Replies;
				const threads = yield* Threads.Threads;
				const runs = yield* ThreadRuns.ThreadRuns;
				const asking = yield* replies.start({ threadId, owner, messages: [message("m1", "Add a note")] });
				// The run asked, and its stream ended: the page shows the question and the person answers it.
				const question = (state: "approval-requested" | "approval-responded"): UIMessage => ({
					id: `msg-${asking.runId}`,
					role: "assistant",
					parts: [
						{
							type: "dynamic-tool",
							toolName: "connector_call",
							toolCallId: "c1",
							input: {},
							state,
							approval: state === "approval-requested" ? { id: "a1" } : { id: "a1", approved: false, reason: "The person denied this." },
						} as UIMessage["parts"][number],
					],
				});
				const first = workflow.started.length;
				const answer = yield* Effect.forkChild(replies.start({ threadId, owner, messages: [message("m1", "Add a note"), question("approval-responded")] }));
				// The run saves its reply a step after its stream ends (chat.ts).
				yield* Effect.sleep("300 millis");
				yield* threads.update(threadId, owner, [message("m1", "Add a note"), question("approval-requested")]);
				yield* runs.finish(threadId, asking.runId, "test-model");

				const answered = yield* Fiber.join(answer);
				assert.strictEqual(workflow.started.length, first + 1, "the answer starts a run");
				assert.strictEqual(answered.runId, workflow.started.at(-1));
			}).pipe(onFakeWorkflow),
		);

		it.effect("Stop and delete at the same time cancel the run once, and the thread is gone", () =>
			Effect.gen(function* () {
				const threadId = `thread-stop-delete-${tag}`;
				const replies = yield* Replies.Replies;
				const started = yield* replies.start({ threadId, owner, messages: [message("m1", "Hi")] });
				const cancels = workflow.cancelled.length;
				// Whichever takes the lock first cancels the run; the other finds none running.
				const [, deleted] = yield* Effect.all([replies.stop(threadId, owner), replies.remove(threadId, owner)], { concurrency: "unbounded" });
				assert.isTrue(deleted);
				assert.deepStrictEqual(workflow.cancelled.slice(cancels), [started.runId]);
				assert.isTrue(Option.isNone(yield* ThreadRuns.ThreadRuns.use((runs) => runs.latest(threadId))));
				assert.isTrue(Option.isNone(yield* Threads.Threads.use((threads) => threads.owner(threadId))));
			}).pipe(onFakeWorkflow),
		);

		it.effect("someone else's thread is not started, stopped or deleted", () =>
			Effect.gen(function* () {
				const threadId = `thread-other-${tag}`;
				const replies = yield* Replies.Replies;
				yield* replies.start({ threadId, owner, messages: [message("m1", "Mine")] });
				const cancels = workflow.cancelled.length;
				const refused = yield* Effect.flip(replies.start({ threadId, owner: "someone-else", messages: [message("m1", "Theirs")] }));
				assert.strictEqual(refused._tag, "ThreadNotYours");
				assert.isFalse(yield* replies.stop(threadId, "someone-else"));
				assert.isFalse(yield* replies.remove(threadId, "someone-else"));
				assert.strictEqual(workflow.cancelled.length, cancels);
				assert.isTrue(Option.isSome(yield* ThreadRuns.ThreadRuns.use((runs) => runs.active(threadId))));
			}).pipe(onFakeWorkflow),
		);

		it.effect("four replies started at once in four chats: one is refused", () =>
			Effect.gen(function* () {
				const replies = yield* Replies.Replies;
				const busy = `test-busy-${tag}`;
				const results = yield* Effect.all(
					[1, 2, 3, 4].map((chat) => Effect.exit(replies.start({ threadId: `thread-busy-${chat}-${tag}`, owner: busy, messages: [message("m1", "Hello")] }))),
					{ concurrency: "unbounded" },
				);
				const refused = results.filter(Exit.isFailure);
				assert.strictEqual(refused.length, 1);
				assert.strictEqual(Exit.findErrorOption(refused[0]!).pipe(Option.getOrThrow)._tag, "TooManyReplies");
			}).pipe(onFakeWorkflow),
		);

		it.effect("stopped calls whose cost is not known yet count as in flight", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const replies = yield* Replies.Replies;
				const stopper = `test-stopper-${tag}`;
				for (const call of [1, 2, 3]) {
					yield* sql`
						insert into runs (id, "user", function_id, model, steps, input_tokens, output_tokens, cached_tokens, cost_usd, duration_ms, finish_reason, created_at)
						values (${`${stopper}-${call}`}, ${stopper}, 'chat', 'test/model', 1, 0, 0, 0, null, 0, 'stopped', now())`;
				}
				const refused = yield* Effect.flip(replies.start({ threadId: `thread-stopper-${tag}`, owner: stopper, messages: [message("m1", "Hello")] }));
				assert.strictEqual(refused._tag, "TooManyReplies");
			}).pipe(onFakeWorkflow),
		);

		it.effect("a sweep stopped in the middle of saving a reply leaves its run for the next sweep", () =>
			Effect.gen(function* () {
				const threadId = `thread-sweep-stop-${tag}`;
				const replies = yield* Replies.Replies;
				const { runId } = yield* replies.start({ threadId, owner: `test-sweep-${tag}`, messages: [message("m1", "Hi")] });
				// The run failed without saving its reply, and its stream is still being read when the sweep stops (SIGTERM).
				workflow.status.set(runId, "failed");
				const reading = Deferred.makeUnsafe<void>();
				workflow.endless.set(runId, reading);
				const sweep = yield* Effect.forkChild(replies.finishEndedRuns);
				yield* Deferred.await(reading);
				yield* Fiber.interrupt(sweep);
				const latest = Option.getOrThrow(yield* ThreadRuns.ThreadRuns.use((runs) => runs.latest(threadId)));
				assert.strictEqual(latest.runId, runId);
				assert.isFalse(latest.finished, "the run was finished without its reply saved");
				workflow.status.delete(runId);
				workflow.endless.delete(runId);
			}).pipe(onFakeWorkflow),
		);
	});
});
