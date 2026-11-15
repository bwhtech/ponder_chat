import type { Context } from "hono";
import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Services } from "./layer.ts";
import { runtime } from "./runtime.ts";

/**
 * Runs a route's effect (a Hono handler's body) on the app's runtime, and answers with
 * what it gives: build the answer inside the effect, with `c.json` or `c.text`, so Hono
 * still infers the route's answers for the typed client (web/api.ts).
 *
 * `errors` maps the tags of the effect's failures to their answers, such as
 * `{ ThreadNotFound: (_, c) => c.json({ error: "Not found" }, 404) }`. A failure with no
 * answer here, and any defect, is thrown as the error itself, so app.onError logs it and
 * answers 500 as it did before.
 *
 * The request closing does not interrupt the effect: a handler always ran to its end,
 * and a rename or a delete must not stop half way.
 */
export async function route<A, E, H extends Answers<E> = {}>(
	c: Context,
	effect: Effect.Effect<A, E, Services>,
	// `& Answers<E>` gives each answer its error's type; H keeps each answer's own type.
	errors?: H & Answers<E>,
): Promise<A | AnswerOf<H>> {
	const exit = await runtime().runPromiseExit(effect);
	if (Exit.isSuccess(exit)) return exit.value;
	const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
	const tag = Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;
	const answer = tag === undefined ? undefined : (errors as Record<string, Answer | undefined> | undefined)?.[tag];
	if (answer) return answer(error as never, c) as AnswerOf<H>;
	throw Cause.squash(exit.cause);
}

type Answer = (error: never, c: Context) => unknown;
type Answers<E> = { readonly [K in Extract<E, { readonly _tag: string }>["_tag"]]?: (error: Extract<E, { readonly _tag: K }>, c: Context) => unknown };
type AnswerOf<H> = { [K in keyof H]: H[K] extends (...args: never[]) => infer R ? R : never }[keyof H];
