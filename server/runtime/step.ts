import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { FatalError, RetryableError, type RetryableErrorOptions } from "workflow";
import type { Services } from "./layer.ts";
import { runtime } from "./runtime.ts";

/**
 * Runs the Effect part of a workflow step ("use step") on the app's runtime. A step loads
 * this, as it loads all its modules, with `await import("../runtime/step.ts")` inside the
 * step: the workflow imports steps.ts, and workflow code cannot load Node modules.
 *
 * By default a failure is thrown as the error itself (the first failure, or else the
 * defect), as the step's code threw it before. So Workflow retries the step as it did:
 * up to the step's maxRetries, one second apart, then fails it.
 *
 * Workflow's own retry rules can be set by tag:
 * - `fatal`: these failures stop the step and fail it at once, as a FatalError. Nothing
 *   is retried: use it for a failure that a retry can't change, such as a thread that is gone.
 * - `retryable`: these failures run the step again after the time given (a RetryableError),
 *   such as a provider's Retry-After. The value is the options, or a function of the error.
 * Both carry the error's message, which a tagged error builds from bounded fields only.
 * The retry inside one step attempt is Effect's (Effect.retry with a Schedule); these say
 * what Workflow does once the attempt has failed.
 */
export async function runStep<A, E>(effect: Effect.Effect<A, E, Services>, rules: StepRules<E> = {}): Promise<A> {
	const exit = await runtime().runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
	const tag = Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;
	if (tag !== undefined) {
		const message = error instanceof Error ? error.message : tag;
		if ((rules.fatal as ReadonlyArray<string> | undefined)?.includes(tag)) throw new FatalError(message);
		const retry = (rules.retryable as Record<string, RetryableErrorOptions | ((error: never) => RetryableErrorOptions)> | undefined)?.[tag];
		if (retry) throw new RetryableError(message, typeof retry === "function" ? retry(error as never) : retry);
	}
	throw Cause.squash(exit.cause);
}

type Tags<E> = Extract<E, { readonly _tag: string }>["_tag"];

export type StepRules<E> = {
	readonly fatal?: ReadonlyArray<Tags<E>>;
	readonly retryable?: {
		readonly [K in Tags<E>]?: RetryableErrorOptions | ((error: Extract<E, { readonly _tag: K }>) => RetryableErrorOptions);
	};
};
