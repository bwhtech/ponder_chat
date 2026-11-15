/**
 * Daily credits and extra credits on a real Postgres (TEST_DATABASE_URL, vitest.config.ts),
 * in a schema of its own (search_path), which the last test drops: other test files make
 * the runs table and its view too, at the same time. The settings row is made from the
 * config below (CHAT_DAILY_CREDITS, CHAT_CREDITS_PER_USD).
 *
 * The day is the clock's: `at(...)` gives the code a fixed wall clock (the database's
 * own `now()` is not moved, so the rows of other days are written with their dates).
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Notify from "../notify/Notify.ts";
import * as Database from "../runtime/Database.ts";
import * as Http from "../runtime/Http.ts";
import * as Settings from "../settings/Settings.ts";
import * as Runs from "../telemetry/Runs.ts";
import * as Credits from "./Credits.ts";
import * as ExtraCredits from "./ExtraCredits.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_credits_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
const layer = Layer.mergeAll(Credits.layer, Runs.layer).pipe(
	Layer.provideMerge(Layer.mergeAll(ExtraCredits.layer, Settings.layer, Notify.layer)),
	Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), CHAT_DAILY_CREDITS: "250", CHAT_CREDITS_PER_USD: "1000" })),
);

const ana = `test-ana-${run}`;
const ben = `test-ben-${run}`;

/** Runs `effect` with the wall clock at `iso`; sleeps and timers stay real. */
const at =
	(iso: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) => {
		const ms = new Date(iso).getTime();
		return Clock.clockWith((real) =>
			Effect.provideService(effect, Clock.Clock, {
				currentTimeMillisUnsafe: () => ms,
				currentTimeMillis: Effect.succeed(ms),
				currentTimeNanosUnsafe: () => BigInt(ms) * 1_000_000n,
				currentTimeNanos: Effect.succeed(BigInt(ms) * 1_000_000n),
				monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: real.monotonicTimeNanos,
				sleep: (duration) => real.sleep(duration),
			}),
		);
	};

/** A run that OpenRouter charged for, with its cost as numeric text (as `runs.cost_usd` holds it). */
const charged = (user: string, createdAt: string, costUsd: string, functionId = "chat", finishReason = "stop") =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		yield* sql`
			insert into runs (id, "user", function_id, model, steps, input_tokens, output_tokens, cached_tokens, cost_usd, duration_ms, finish_reason, created_at)
			values (${`${user}-${Math.random()}`}, ${user}, ${functionId}, 'test/model', 1, 1, 1, 0, ${costUsd}::numeric, 1, ${finishReason}, ${createdAt}::timestamptz)`;
	});

describe.skipIf(!base)("Credits", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("migrates twice without a change", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				yield* Runs.Runs.use((runs) => runs.migrate);
				const credits = yield* Credits.Credits;
				yield* credits.migrate;
				yield* credits.migrate;
			}),
		);

		it.effect("counts today's charged runs at the settings' rate, against the person's limit and today's extra credits", () =>
			Effect.gen(function* () {
				const credits = yield* Credits.Credits;
				const sql = yield* PgClient.PgClient;
				yield* credits.setDailyCredits(ana, 50);
				// Today's: two replies. Not today's or not charged: a title, a failed call, yesterday's run.
				yield* charged(ana, "2026-11-05T10:00:00Z", "0.01234");
				yield* charged(ana, "2026-11-05T11:00:00Z", "0.0001");
				yield* charged(ana, "2026-11-05T11:30:00Z", "1", "thread-title");
				yield* charged(ana, "2026-11-05T11:40:00Z", "1", "chat", "failed");
				yield* charged(ana, "2026-11-04T23:59:59Z", "2");
				yield* sql`insert into credit_grants (user_id, day, credits, granted_by) values (${ana}, '2026-11-05', 7, 'test'), (${ana}, '2026-11-04', 100, 'test')`;

				const status = yield* credits.status(ana).pipe(at("2026-11-05T12:00:00Z"));
				// $0.01234 + $0.0001 at 1000 credits a dollar: 12.44, rounded to one place.
				assert.deepStrictEqual(status, {
					limit: 57,
					used: 12.4,
					remaining: 44.6,
					resetsAt: "2026-11-06T00:00:00.000Z",
					extra: 7,
					request: null,
				});
			}),
		);

		it.effect("starts again at midnight UTC, on the person's own limit", () =>
			Effect.gen(function* () {
				const credits = yield* Credits.Credits;
				const before = yield* credits.status(ana).pipe(at("2026-11-05T23:59:59.999Z"));
				assert.strictEqual(before.extra, 7);
				assert.isAbove(before.used, 0);
				const after = yield* credits.status(ana).pipe(at("2026-11-06T00:00:00Z"));
				assert.deepStrictEqual(after, { limit: 50, used: 0, remaining: 50, resetsAt: "2026-11-07T00:00:00.000Z", extra: 0, request: null });
			}),
		);

		it.effect("puts a person back on the default limit", () =>
			Effect.gen(function* () {
				const credits = yield* Credits.Credits;
				assert.deepStrictEqual(yield* credits.ownLimit(ana), Option.some(50));
				yield* credits.setDailyCredits(ana, 80);
				assert.deepStrictEqual(yield* credits.ownLimit(ana), Option.some(80));
				yield* credits.setDailyCredits(ana, null);
				assert.deepStrictEqual(yield* credits.ownLimit(ana), Option.none());
				assert.strictEqual((yield* credits.status(ana).pipe(at("2026-11-06T08:00:00Z"))).limit, 250);
			}),
		);

		it.effect("refuses a request while credits are left, and takes one request at a time", () =>
			Effect.gen(function* () {
				const credits = yield* Credits.Credits;
				const extra = yield* ExtraCredits.ExtraCredits;
				const asker = { id: ben, name: "Ben", email: `${ben}@example.invalid` };
				yield* credits.setDailyCredits(ben, 5);
				const left = yield* Effect.exit(credits.request(asker, "http://localhost:3500"));
				assert.isTrue(Exit.isFailure(left) && Exit.findErrorOption(left).pipe(Option.exists((error) => error._tag === "CreditsLeft")));

				yield* credits.setDailyCredits(ben, 0);
				const pendingBefore = yield* extra.pendingCount;
				const status = yield* credits.request(asker, "http://localhost:3500");
				assert.strictEqual(status.request?.status, "pending");
				assert.isNull(status.request?.credits);
				assert.strictEqual(yield* extra.pendingCount, pendingBefore + 1);
				const again = yield* Effect.exit(credits.request(asker, "http://localhost:3500"));
				assert.isTrue(Exit.isFailure(again) && Exit.findErrorOption(again).pipe(Option.exists((error) => error._tag === "AlreadyAsked")));
				// The table allows one pending request per person, whoever asks.
				assert.deepStrictEqual(yield* extra.ask(ben), Option.none());
			}),
		);

		it.effect("an approval gives credits for today only, and a request is answered once", () =>
			Effect.gen(function* () {
				const credits = yield* Credits.Credits;
				const extra = yield* ExtraCredits.ExtraCredits;
				const [request] = (yield* extra.pending).filter((one) => one.user_id === ben);
				assert.isDefined(request);
				assert.deepStrictEqual(yield* extra.decide(request!.id, { status: "approved", credits: 30 }, "test-admin"), Option.some(ben));
				assert.deepStrictEqual(yield* extra.decide(request!.id, { status: "declined" }, "test-admin"), Option.none());

				const status = yield* credits.status(ben);
				assert.strictEqual(status.extra, 30);
				assert.strictEqual(status.limit, 30);
				assert.deepInclude(status.request, { status: "approved", credits: 30 });
				const decided = (yield* extra.decided(30)).find((one) => one.id === request!.id);
				assert.deepInclude(decided, { user_id: ben, status: "approved", credits: 30, decided_by: "test-admin" });
				assert.isFalse((yield* extra.pending).some((one) => one.id === request!.id));

				// A grant without a request adds to the same day; the next day has none.
				yield* extra.grant(ben, 5, "test-admin");
				assert.strictEqual((yield* credits.status(ben)).extra, 35);
				const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
				assert.strictEqual((yield* credits.status(ben).pipe(at(tomorrow))).extra, 0);
				// A new request is possible once the last one is answered.
				assert.isTrue(Option.isSome(yield* extra.ask(ben)));
			}),
		);

		it.effect("drops the test's schema", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`drop schema ${sql.literal(schema)} cascade`;
			}),
		);
	});
});

describe("credit math", () => {
	it("rounds credits to one decimal place", () => {
		assert.strictEqual(Credits.toCredits(0.012445, 1000), 12.4);
		assert.strictEqual(Credits.toCredits(0.00005, 1000), 0.1);
		assert.strictEqual(Credits.toCredits(0, 1000), 0);
		assert.strictEqual(Credits.toCredits(1.23456, 2000), 2469.1);
	});

	it("cuts the UTC day at midnight", () => {
		assert.deepStrictEqual(Credits.utcDay(new Date("2026-11-05T23:59:59.999Z")), {
			start: new Date("2026-11-05T00:00:00Z"),
			day: "2026-11-05",
			resetsAt: new Date("2026-11-06T00:00:00Z"),
		});
		assert.strictEqual(Credits.utcDay(new Date("2026-11-06T00:00:00Z")).day, "2026-11-06");
		// Not the server's time zone: 23:30 in UTC-5 is the next UTC day.
		assert.strictEqual(Credits.utcDay(new Date("2026-12-31T23:30:00-05:00")).day, "2027-01-01");
	});
});
