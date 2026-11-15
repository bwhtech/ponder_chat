import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { fingerprint, isCurrent } from "./fingerprint.ts";
import type { Summary } from "./summary.ts";
import { DEFAULT_RATIO } from "./tokens.ts";

/**
 * What compaction keeps for each thread: its summary, and how many tokens the provider
 * counts for each token Ponder estimates (tokens.ts). Both go with the thread.
 *
 * Failures are the database's own (SqlError): compaction runs in a workflow step, whose
 * boundary (runStep) throws it, so Workflow runs the step again as before.
 */
const SummaryRow = Schema.Struct({
	summary: Schema.String,
	covers: Schema.Number,
	reads: Schema.NullOr(Schema.Number),
	fingerprint: Schema.String,
	keep_files: Schema.Boolean,
});
const RatioRow = Schema.Struct({ ratio: Schema.Number });

export class CompactionStore extends Context.Service<
	CompactionStore,
	{
		/** Creates `thread_summaries` and `thread_token_ratios`. After `threads`: they reference it. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The thread's summary, if the messages the summarizer read are still the same. */
		readonly loadSummary: (threadId: string, thread: UIMessage[]) => Effect.Effect<Option.Option<Summary>, SqlError>;
		/** Replaces the thread's summary. Nothing is saved for a thread deleted meanwhile. */
		readonly saveSummary: (threadId: string, thread: UIMessage[], summary: Summary, model: string) => Effect.Effect<void, SqlError>;
		/** The thread's measured ratio for this model, or the default before a call of it was measured. */
		readonly tokenRatio: (threadId: string, model: string) => Effect.Effect<number, SqlError>;
		readonly saveTokenRatio: (threadId: string, model: string, ratio: number) => Effect.Effect<void, SqlError>;
	}
>()("ponder/compaction/CompactionStore") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists thread_summaries (
				thread_id text primary key references threads (id) on delete cascade,
				summary text not null,
				covers integer not null,
				fingerprint text not null,
				keep_files boolean not null default true,
				reads integer,
				model text not null,
				created_at timestamptz not null default now()
			)`;
		yield* sql`alter table thread_summaries add column if not exists reads integer`;
		yield* sql`
			create table if not exists thread_token_ratios (
				thread_id text primary key references threads (id) on delete cascade,
				model text not null,
				ratio real not null,
				updated_at timestamptz not null default now()
			)`;
	});

	const findSummary = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: SummaryRow,
		execute: (threadId) => sql`select summary, covers, reads, fingerprint, keep_files from thread_summaries where thread_id = ${threadId}`,
	});

	// No span of its own: compaction.run and the reply's first step read it.
	const loadSummary = Effect.fnUntraced(function* (threadId: string, thread: UIMessage[]) {
		const found = yield* findSummary(threadId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.flatMap(found, (row) => {
			const reads = row.reads ?? row.covers;
			if (!isCurrent(thread, { reads, fingerprint: row.fingerprint })) return Option.none<Summary>();
			return Option.some<Summary>({ text: row.summary, covers: row.covers, keepFiles: row.keep_files, reads });
		});
	});

	const saveSummary = Effect.fn("CompactionStore.saveSummary")(function* (threadId: string, thread: UIMessage[], summary: Summary, model: string) {
		const reads = summary.reads ?? summary.covers;
		yield* sql`
			insert into thread_summaries (thread_id, summary, covers, reads, fingerprint, keep_files, model)
			select ${threadId}, ${summary.text}, ${summary.covers}, ${reads}, ${fingerprint(thread.slice(0, reads))}, ${summary.keepFiles}, ${model}
			where exists (select 1 from threads where id = ${threadId})
			on conflict (thread_id) do update set summary = excluded.summary, covers = excluded.covers, reads = excluded.reads,
				fingerprint = excluded.fingerprint, keep_files = excluded.keep_files, model = excluded.model, created_at = now()`;
	});

	const findRatio = SqlSchema.findOneOption({
		Request: Schema.Struct({ threadId: Schema.String, model: Schema.String }),
		Result: RatioRow,
		execute: ({ threadId, model }) => sql`select ratio from thread_token_ratios where thread_id = ${threadId} and model = ${model}`,
	});

	// No span of its own: the reply's first step reads it.
	const tokenRatio = Effect.fnUntraced(function* (threadId: string, model: string) {
		const found = yield* findRatio({ threadId, model }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.match(found, { onNone: () => DEFAULT_RATIO, onSome: (row) => row.ratio });
	});

	const saveTokenRatio = Effect.fn("CompactionStore.saveTokenRatio")(function* (threadId: string, model: string, ratio: number) {
		yield* sql`
			insert into thread_token_ratios (thread_id, model, ratio)
			select ${threadId}, ${model}, ${ratio} where exists (select 1 from threads where id = ${threadId})
			on conflict (thread_id) do update set model = excluded.model, ratio = excluded.ratio, updated_at = now()`;
	});

	return CompactionStore.of({ migrate, loadSummary, saveSummary, tokenRatio, saveTokenRatio });
});

export const layer = Layer.effect(CompactionStore, make);
