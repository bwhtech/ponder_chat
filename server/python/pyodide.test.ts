/**
 * The sandbox's process: the reply it reads, and the runs it stops. Deno is the outside
 * system here, so a fake stands in for it: a small Node program that acts on the code it
 * is sent. "hang" starts a child that sleeps and never answers; its stdout stays open
 * until the whole process group is gone, so a run that returns has killed both.
 * Time is the TestClock's: a run's 60 seconds pass at once.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as PonderConfig from "../config.ts";
import * as Sandbox from "./pyodide.ts";

const dir = mkdtempSync(join(tmpdir(), "ponder-sandbox-test-"));
const runner = join(dir, "fake-runner.mjs");
writeFileSync(
	runner,
	`import { spawn } from "node:child_process";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
	const { nonce, code } = JSON.parse(input);
	if (code === "hang") return void spawn("sleep", ["600"], { stdio: "inherit" });
	if (code === "fail") {
		process.stderr.write("first\\nsecond\\nthird\\nfourth\\n");
		process.exit(1);
	}
	console.log("a line the code printed");
	console.log(nonce + JSON.stringify({ ok: true, stdout: "hi\\n", stderr: "", outputs: [], skippedOutputs: [], packages: ["numpy"] }));
});
`,
);
const deno = join(dir, "deno");
writeFileSync(deno, `#!/bin/sh\nexec node ${JSON.stringify(runner)}\n`);
chmodSync(deno, 0o755);

// One run at a time, so a slot that is not freed holds back the next run.
const env = { PONDER_DENO: deno, PONDER_SANDBOX_DIR: dir, PYTHON_MAX_RUNS: "1", PATH: process.env.PATH ?? "" };
const layer = Sandbox.layer.pipe(Layer.provide(PonderConfig.layerFromEnv(env)));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Sandbox", () => {
	it.layer(layer)((it) => {
		it.effect("reads the reply line that carries the nonce", () =>
			Effect.gen(function* () {
				const sandbox = yield* Sandbox.Sandbox;
				const reply = yield* sandbox.run({ code: "print('hi')" });
				assert.strictEqual(reply.ok, true);
				assert.strictEqual(reply.stdout, "hi\n");
				assert.deepStrictEqual(reply.packages, ["numpy"]);
			}),
		);

		it.effect("a process with no reply gives the last lines of its errors", () =>
			Effect.gen(function* () {
				const reply = yield* Sandbox.Sandbox.use((sandbox) => sandbox.run({ code: "fail" }));
				assert.strictEqual(reply.ok, false);
				assert.strictEqual(reply.error, "The sandbox failed: second third fourth");
				assert.strictEqual(reply.stopped, undefined);
			}),
		);

		it.effect("a run over its time is stopped, with what it started", () =>
			Effect.gen(function* () {
				const run = yield* Sandbox.Sandbox.use((sandbox) => sandbox.run({ code: "hang" })).pipe(Effect.forkChild);
				yield* TestClock.adjust("60 seconds");
				const reply = yield* Fiber.join(run);
				assert.strictEqual(reply.stopped, "time");
				assert.strictEqual(reply.error, "The run was stopped after 60 seconds.");
			}),
		);

		it.effect("an interrupted run ends its processes, and frees its slot", () =>
			Effect.gen(function* () {
				const sandbox = yield* Sandbox.Sandbox;
				const run = yield* sandbox.run({ code: "hang" }).pipe(Effect.forkChild);
				yield* TestClock.adjust("1 second");
				// Returns once the process group's pipes have closed.
				yield* Fiber.interrupt(run);
				const next = yield* sandbox.run({ code: "print('hi')" });
				assert.strictEqual(next.ok, true);
			}),
		);

		it.effect("is off without the sandbox's files", () =>
			Effect.gen(function* () {
				assert.strictEqual(yield* Sandbox.Sandbox.use((sandbox) => sandbox.check), false);
			}),
		);
	});
});
