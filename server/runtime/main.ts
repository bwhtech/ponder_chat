import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { Services } from "./layer.ts";
import { dispose, runtime } from "./runtime.ts";

/**
 * Runs a script's program (a check script, a CLI in scripts/) on the app's runtime, then
 * disposes the runtime, so the database pool closes and the process can end.
 *
 * A failure is printed, as Effect's Cause (its errors and their stacks), and sets exit
 * code 1; the value is then undefined. The process is not exited here: a check script
 * prints its own summary and ends as it did, with `process.exit`.
 */
export async function runMain<A, E>(effect: Effect.Effect<A, E, Services>): Promise<A | undefined> {
	try {
		const exit = await runtime().runPromiseExit(effect);
		if (Exit.isSuccess(exit)) return exit.value;
		console.error(Cause.pretty(exit.cause));
		process.exitCode = 1;
		return undefined;
	} finally {
		await dispose();
	}
}
