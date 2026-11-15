/**
 * The boundaries between Promise code and the runtime: route() for Hono, runStep() for
 * workflow steps. No database: the effects here need no service.
 */
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hono } from "hono";
import { FatalError, RetryableError } from "workflow";
import { route } from "./route.ts";
import { dispose } from "./runtime.ts";
import { runStep } from "./step.ts";

class ThreadGone extends Schema.TaggedError<ThreadGone>()("ThreadGone", { threadId: Schema.String }) {
	override get message() {
		return `Thread ${this.threadId} is gone.`;
	}
}
class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { afterMs: Schema.Number }) {}

afterAll(() => dispose());

describe("runStep", () => {
	it("gives the effect's value", async () => {
		assert.strictEqual(await runStep(Effect.succeed(42)), 42);
	});

	it("throws the failure itself by default, so Workflow retries the step as before", async () => {
		const failure = new ThreadGone({ threadId: "t1" });
		const thrown = await runStep(Effect.fail(failure)).catch((error: unknown) => error);
		assert.strictEqual(thrown, failure);
		assert.isFalse(FatalError.is(thrown));
	});

	it("throws a defect itself, such as an error a promise rejected with", async () => {
		const defect = new TypeError("not a function");
		assert.strictEqual(await runStep(Effect.die(defect)).catch((error: unknown) => error), defect);
	});

	it("stops the step with a FatalError for the tags marked fatal", async () => {
		const thrown = await runStep(Effect.fail(new ThreadGone({ threadId: "t1" })), { fatal: ["ThreadGone"] }).catch((error: unknown) => error);
		assert.isTrue(FatalError.is(thrown));
		assert.strictEqual((thrown as Error).message, "Thread t1 is gone.");
	});

	it("runs the step again after the time a retryable failure gives", async () => {
		const before = Date.now();
		const effect: Effect.Effect<never, ThreadGone | RateLimited> = Effect.fail(new RateLimited({ afterMs: 5_000 }));
		const thrown = await runStep(effect, { fatal: ["ThreadGone"], retryable: { RateLimited: (error) => ({ retryAfter: error.afterMs }) } }).catch((error: unknown) => error);
		assert.isTrue(RetryableError.is(thrown));
		assert.isAtLeast((thrown as RetryableError).retryAfter.getTime(), before + 5_000);
	});
});

describe("route", () => {
	const app = new Hono();
	let reachedOnError: unknown;
	const unmapped = new RateLimited({ afterMs: 1 });
	app.get("/ok", (c) => route(c, Effect.sync(() => c.text("ok"))));
	app.get("/gone", (c) =>
		route(c, Effect.fail(new ThreadGone({ threadId: "t1" })) as Effect.Effect<Response, ThreadGone | RateLimited>, {
			ThreadGone: (_, c) => c.json({ error: "Not found" }, 404),
		}),
	);
	app.get("/limited", (c) =>
		route(c, Effect.fail(unmapped) as Effect.Effect<Response, ThreadGone | RateLimited>, {
			ThreadGone: (_, c) => c.json({ error: "Not found" }, 404),
		}),
	);
	app.onError((error, c) => {
		reachedOnError = error;
		return c.text("Internal Server Error", 500);
	});

	it("answers with what the effect gives", async () => {
		const response = await app.request("/ok");
		assert.strictEqual(response.status, 200);
		assert.strictEqual(await response.text(), "ok");
	});

	it("answers a failure with the answer given for its tag", async () => {
		const response = await app.request("/gone");
		assert.strictEqual(response.status, 404);
		assert.deepStrictEqual(await response.json(), { error: "Not found" });
	});

	it("leaves any other failure to app.onError, as the error itself", async () => {
		const response = await app.request("/limited");
		assert.strictEqual(response.status, 500);
		assert.strictEqual(reachedOnError, unmapped);
	});
});
