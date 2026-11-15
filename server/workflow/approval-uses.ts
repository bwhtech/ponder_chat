import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type { Answer } from "./answered-again.ts";

/**
 * Each approval the person answered, once a run was started to carry it out: the durable
 * fact that the answer was used. A second answer to the same request (another tab, a
 * resend, an old card after Stop or Retry) starts nothing (replies.ts).
 *
 * The row is written before the run starts, so before the call it approves can reach an
 * app. Neither Stop, a failed run, Retry nor a saved reply that changes removes it: only
 * deleting the thread does.
 */

/** One of the answers was used before: the transaction rolls back, and none is recorded. */
class AlreadyUsed extends Schema.TaggedError<AlreadyUsed>()("AlreadyUsed", {}) {}

export class ApprovalUses extends Context.Service<
	ApprovalUses,
	{
		readonly migrate: Effect.Effect<void, SqlError>;
		/**
		 * Records the answers as used. True when none of them was used before; then all of them
		 * are recorded. False when one was: then none is.
		 */
		readonly use: (threadId: string, answers: Answer[]) => Effect.Effect<boolean, SqlError>;
		/** The run that carries the answers out, once it has an id. */
		readonly usedBy: (threadId: string, answers: Answer[], runId: string) => Effect.Effect<void, SqlError>;
		/** The run could not start: the answers were not used, and can be sent again. */
		readonly release: (threadId: string, answers: Answer[]) => Effect.Effect<void, SqlError>;
		/** For a deleted thread. */
		readonly forget: (threadId: string) => Effect.Effect<void, SqlError>;
	}
>()("ponder/workflow/ApprovalUses") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists approval_uses (
				thread_id text not null,
				approval_id text not null,
				tool_call_id text not null,
				approved boolean not null,
				run_id text,
				used_at timestamptz not null default now(),
				primary key (thread_id, approval_id)
			)`;
	});

	const use = Effect.fn("ApprovalUses.use")(function* (threadId: string, answers: Answer[]) {
		return yield* Effect.gen(function* () {
			for (const answer of answers) {
				const rows = yield* sql`
					insert into approval_uses (thread_id, approval_id, tool_call_id, approved)
					values (${threadId}, ${answer.approvalId}, ${answer.toolCallId}, ${answer.approved})
					on conflict do nothing returning approval_id`;
				if (!rows.length) return yield* new AlreadyUsed();
			}
			return true;
		}).pipe(sql.withTransaction, Effect.catchTags({ AlreadyUsed: () => Effect.succeed(false) }));
	});

	const ids = (answers: Answer[]) => sql.in(answers.map((answer) => answer.approvalId));

	const usedBy = Effect.fn("ApprovalUses.usedBy")(function* (threadId: string, answers: Answer[], runId: string) {
		yield* sql`update approval_uses set run_id = ${runId} where thread_id = ${threadId} and approval_id in ${ids(answers)}`;
	});

	const release = Effect.fn("ApprovalUses.release")(function* (threadId: string, answers: Answer[]) {
		yield* sql`delete from approval_uses where thread_id = ${threadId} and approval_id in ${ids(answers)} and run_id is null`;
	});

	const forget = Effect.fn("ApprovalUses.forget")(function* (threadId: string) {
		yield* sql`delete from approval_uses where thread_id = ${threadId}`;
	});

	return ApprovalUses.of({ migrate, use, usedBy, release, forget });
});

export const layer = Layer.effect(ApprovalUses, make);
