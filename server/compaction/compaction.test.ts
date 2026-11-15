/**
 * The summarizer (summarize.ts) with a fake model, and compaction's store (store.ts) on a
 * real Postgres when TEST_DATABASE_URL is set. compaction.check.ts and
 * compaction-flow.check.ts check the pure parts and one compaction run.
 */
import * as PgClient from "@effect/sql-pg/PgClient";
import { assert, describe, it } from "@effect/vitest";
import type { OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import type { UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as PonderConfig from "../config.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Database from "../runtime/Database.ts";
import * as Settings from "../settings/Settings.ts";
import * as Threads from "../threads/Threads.ts";
import * as CompactionStore from "./store.ts";
import * as Summarizer from "./summarize.ts";
import { DEFAULT_RATIO } from "./tokens.ts";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
type Generate = ConstructorParameters<typeof MockLanguageModelV4>[0] extends infer O ? (O extends { doGenerate?: infer G } ? Extract<G, (...args: never[]) => unknown> : never) : never;

/** The summarizer's world: the model answers with `generate`; admins chose `chosen`, which has a window of `window`. */
function summarizerWith(generate: Generate, { chosen = "small/summarizer", window = 1_000_000 } = {}) {
	const called: string[] = [];
	const provider = ((model: string) => (called.push(model), new MockLanguageModelV4({ doGenerate: generate }))) as unknown as OpenRouterProvider;
	const unused = Effect.die("unused");
	const layer = Summarizer.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(OpenRouterKey.OpenRouterKey, OpenRouterKey.OpenRouterKey.of({ key: Effect.succeed("k"), provider: Effect.succeed(provider), status: unused, check: () => unused, save: () => unused })),
				Layer.succeed(
					AutoRouter.AutoRouter,
					AutoRouter.AutoRouter.of({ plugin: unused, answeringModel: () => unused, lastAnsweringModel: () => unused, modelWindow: (id) => Effect.succeed(Option.some(id === chosen ? window : 128_000)) }),
				),
				Layer.succeed(
					Models.Models,
					Models.Models.of({
						available: unused,
						cached: unused,
						pick: () => unused,
						privateModels: Effect.succeed([{ id: chosen, name: "Summarizer", provider: "Small", description: "", readsPdf: false }]),
					} as unknown as Models.Models["Service"]),
				),
				Layer.succeed(
					Settings.Settings,
					Settings.Settings.of({
						migrate: Effect.void,
						get: Effect.succeed({ defaultDailyCredits: 1000, creditsPerUsd: 1000, pdfTextOnServer: true, compactionModel: chosen, autoCostTier: "medium" }),
						update: () => unused,
						setPdfTextOnServer: () => unused,
						setCompactionModel: () => unused,
						setAutoCostTier: () => unused,
					}),
				),
			),
		),
	);
	return { called, layer };
}

const answer = (text: string, finish: "stop" | "length" = "stop"): Generate => async () => ({
	content: [{ type: "text", text }],
	finishReason: { unified: finish, raw: finish },
	usage,
	warnings: [],
});

const thread: UIMessage[] = [
	{ id: "u1", role: "user", parts: [{ type: "text", text: "Plan a trip to Lisbon" }] },
	{ id: "a1", role: "assistant", parts: [{ type: "text", text: "Day one: Alfama." }] },
];
const input = { run: { threadId: "t1", user: "p1" }, chatModel: "big/chat", previous: undefined, messages: thread, ratio: 1 };

const write = Summarizer.Summarizer.use((summarizer) => summarizer.write(input));

describe("the summarizer", () => {
	it.effect("writes with the model admins chose, and trims the summary", () => {
		const world = summarizerWith(answer("  The person plans a trip.  "));
		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* write, { text: "The person plans a trip.", model: "small/summarizer" });
			assert.deepStrictEqual(world.called, ["small/summarizer"]);
		}).pipe(Effect.provide(world.layer));
	});

	it.effect("writes with the chat's model when the chosen one has too small a window", () => {
		const world = summarizerWith(answer("Summary."), { window: 1_000 });
		return Effect.map(write, (written) => assert.strictEqual(written.model, "big/chat")).pipe(Effect.provide(world.layer));
	});

	it.effect("fails on an empty summary, and on one cut off by the output limit", () =>
		Effect.gen(function* () {
			const empty = yield* Effect.flip(write.pipe(Effect.provide(summarizerWith(answer("  ")).layer)));
			assert.strictEqual(empty.message, "small/summarizer wrote an empty summary");
			const cut = yield* Effect.flip(write.pipe(Effect.provide(summarizerWith(answer("Half a", "length")).layer)));
			assert.strictEqual(cut.message, "small/summarizer ran out of room for the summary");
		}),
	);

	it.effect("gives up after three minutes, and aborts the call", () => {
		let aborted = false;
		const hanging: Generate = ({ abortSignal }) =>
			new Promise((_, reject) => abortSignal?.addEventListener("abort", () => ((aborted = true), reject(abortSignal.reason))));
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(write);
			yield* TestClock.adjust("3 minutes");
			const error = yield* Effect.flip(Fiber.join(fiber));
			assert.deepStrictEqual([error._tag, error.message], ["SummaryFailed", "The operation was aborted due to timeout"]);
			assert.isTrue(aborted);
		}).pipe(Effect.provide(summarizerWith(hanging).layer));
	});
});

const url = process.env.TEST_DATABASE_URL;
const database = Layer.mergeAll(CompactionStore.layer, Threads.layer).pipe(
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})),
);
const run = Math.random().toString(36).slice(2, 10);
const owner = `test-${run}`;

describe.skipIf(!url)("compaction's store", () => {
	it.layer(database, { excludeTestServices: true })((it) => {
		it.effect("keeps a summary while the messages it read stay the same, and the thread's token ratio", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const store = yield* CompactionStore.CompactionStore;
				yield* threads.migrate;
				yield* store.migrate;
				const id = `${run}-summary`;
				yield* threads.save(id, owner, thread);
				assert.deepStrictEqual(yield* store.loadSummary(id, thread), Option.none());
				yield* store.saveSummary(id, thread, { text: "A trip.", covers: 1, keepFiles: false, reads: 2 }, "small/summarizer");
				assert.deepStrictEqual(yield* store.loadSummary(id, thread), Option.some({ text: "A trip.", covers: 1, keepFiles: false, reads: 2 }));
				// An edit to a message it read makes it stale.
				const edited = [thread[0], { ...thread[1], parts: [{ type: "text" as const, text: "Day one: Belém." }] }];
				assert.deepStrictEqual(yield* store.loadSummary(id, edited), Option.none());

				assert.strictEqual(yield* store.tokenRatio(id, "big/chat"), DEFAULT_RATIO);
				yield* store.saveTokenRatio(id, "big/chat", 1.25);
				assert.strictEqual(yield* store.tokenRatio(id, "big/chat"), 1.25);
				// One ratio per thread: the last model measured.
				yield* store.saveTokenRatio(id, "other/model", 2);
				assert.strictEqual(yield* store.tokenRatio(id, "big/chat"), DEFAULT_RATIO);
				assert.strictEqual(yield* store.tokenRatio(id, "other/model"), 2);
			}),
		);

		it.effect("saves nothing for a thread deleted meanwhile", () =>
			Effect.gen(function* () {
				const store = yield* CompactionStore.CompactionStore;
				const id = `${run}-gone`;
				yield* store.saveSummary(id, thread, { text: "A trip.", covers: 1, keepFiles: true }, "m");
				yield* store.saveTokenRatio(id, "m", 1.5);
				assert.deepStrictEqual(yield* store.loadSummary(id, thread), Option.none());
				assert.strictEqual(yield* store.tokenRatio(id, "m"), DEFAULT_RATIO);
			}),
		);

		it.effect("cleans up", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				// The summaries and ratios go with their threads.
				yield* sql`delete from threads where owner = ${owner}`;
			}),
		);
	});
});
