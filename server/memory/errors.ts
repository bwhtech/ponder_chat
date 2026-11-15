import { APICallError } from "ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { isSqlError } from "effect/sql/SqlError";
import { sqlMessage } from "../runtime/Database.ts";

/**
 * Memory's failures. Each names the model and, when it answered, its HTTP status: never
 * the turn, a memory's text, or the provider's own answer, which can quote what it was
 * sent (docs/effect.md, "Errors of a service"). The original error is the cause.
 */

/** The gate (decision-gate.ts) gave no decision: the Decisions API answered with an error, or could not be reached. */
export class MemoryGateFailed extends Schema.TaggedError<MemoryGateFailed>()("MemoryGateFailed", {
	model: Schema.String,
	/** "HTTP 503", or fetch's own words for a request that got no answer ("fetch failed"). */
	problem: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return `Memory gate (${this.model}): ${this.problem}`;
	}
}

/** The writer's model call (extract.ts) failed. */
export class MemoryWriterFailed extends Schema.TaggedError<MemoryWriterFailed>()("MemoryWriterFailed", {
	model: Schema.String,
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return `Memory writer (${this.model}) failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}`;
	}
}

/** The embeddings for the search index (pgvector-index.ts) could not be made. */
export class EmbeddingFailed extends Schema.TaggedError<EmbeddingFailed>()("EmbeddingFailed", {
	model: Schema.String,
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return `Embeddings (${this.model}) failed${this.status === undefined ? "" : ` (HTTP ${this.status})`}`;
	}
}

/** The HTTP status of a failed AI SDK call, when the provider answered. */
export function statusOf(error: unknown): number | undefined {
	return APICallError.isInstance(error) ? error.statusCode : undefined;
}

/**
 * What a failure says in a log line and in the save log: Postgres's own message for a
 * database error, as postgres.js printed it, else the error's message, which a tagged
 * error builds from its bounded fields.
 */
export function problem(error: unknown): string {
	if (isSqlError(error)) return sqlMessage(error);
	if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) return error.message;
	return String(error);
}

/**
 * Recovers from any failure or defect, as a Promise's catch did: memory never stops the
 * chat. An interruption stays one, so a stopped run still stops.
 */
export const recoverAll =
	<B, E2, R2>(onError: (error: unknown) => Effect.Effect<B, E2, R2>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, E2, R | R2> =>
		effect.pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : onError(Cause.squash(cause)))));
