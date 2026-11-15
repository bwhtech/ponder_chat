/**
 * A chat's Python state on a real Postgres (TEST_DATABASE_URL): kept for the person's own
 * thread only, and not for a thread that is gone.
 */
import { randomUUID } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Threads from "../threads/Threads.ts";
import type { PythonState as State } from "./pyodide.ts";
import * as PythonState from "./state.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Layer.mergeAll(PythonState.layer, Threads.layer).pipe(
	Layer.provideMerge(Database.layer),
	Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})),
);

const state: State = { globals: "gASVAAAA", imports: ["pandas as pd"], files: [{ path: "/work/notes.txt", base64: "aGk=" }] };

describe.skipIf(!url)("PythonState", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("keeps the state of the person's own thread, and forgets it", () =>
			Effect.gen(function* () {
				const states = yield* PythonState.PythonState;
				const threads = yield* Threads.Threads;
				yield* threads.migrate;
				yield* states.migrate;
				const [thread, owner] = [`python-test-${randomUUID()}`, `python-test-${randomUUID()}`];
				yield* threads.save(thread, owner, []);

				yield* states.save(thread, owner, state);
				assert.deepStrictEqual(Option.getOrThrow(yield* states.load(thread, owner)), state);
				assert.isTrue(Option.isNone(yield* states.load(thread, "someone-else")));
				// Someone else's run can't write over it.
				yield* states.save(thread, "someone-else", { imports: [], files: [] });
				assert.deepStrictEqual(Option.getOrThrow(yield* states.load(thread, owner)), state);

				yield* states.forget(thread, owner);
				assert.isTrue(Option.isNone(yield* states.load(thread, owner)));
				yield* threads.remove(thread, owner);
			}),
		);

		it.effect("keeps nothing for a thread that is gone", () =>
			Effect.gen(function* () {
				const states = yield* PythonState.PythonState;
				const [thread, owner] = [`python-test-${randomUUID()}`, `python-test-${randomUUID()}`];
				yield* states.save(thread, owner, state);
				assert.isTrue(Option.isNone(yield* states.load(thread, owner)));
			}),
		);
	});
});
