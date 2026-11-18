import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as ObjectStore from "../files/ObjectStore.ts";
import { DOCUMENT_RUNS, indexLog, type LogEntry } from "./documents/log.ts";
import { documentStore, PROGRESS_COLUMNS, ProgressFields, progressOf, type DocumentStatus, type DocumentSummary, summaryOf } from "./documents/store.ts";

/**
 * Workspaces as /admin/workspaces sees them (docs/workspaces-plan.md, "Indexing log",
 * point 4). Workspaces open to everyone in full: their owner, documents, statuses, errors,
 * indexing cost and each document's log. Private workspaces only as totals: how many,
 * their documents by status, what indexing them cost, and the errors of the failed ones.
 *
 * Nothing about a private workspace leaves here that names it or its documents, or that
 * could open them: no id, no name, no owner. An error is the indexer's text, which can
 * hold a model's error message, so the names are cut out of it before it is counted.
 */
export type OrgDocument = DocumentSummary & {
	/** What its indexing runs cost, from `runs`; null when no model call cost anything yet. */
	costUsd: number | null;
};

export type OrgWorkspace = {
	id: string;
	/** Its address in the chat: `/?w=<slug>`. */
	slug: string;
	name: string;
	description: string;
	icon: string | null;
	owner: { id: string; name: string; email: string };
	/** The people added to it, who keep their roles if it is closed to everyone again. */
	memberCount: number;
	createdAt: string;
	updatedAt: string;
	/** Oldest first. */
	documents: OrgDocument[];
	/** All its documents together; null when nothing cost anything yet. */
	costUsd: number | null;
};

export type PrivateSummary = {
	workspaces: number;
	documents: Record<DocumentStatus, number>;
	costUsd: number;
	/** The errors of failed documents, the most common first, without names. */
	errors: { error: string; documents: number }[];
};

export type WorkspacesReport = { org: OrgWorkspace[]; private: PrivateSummary };
export type DocumentLog = { document: DocumentSummary; steps: LogEntry[] };

/** At most this many kinds of error are listed for private workspaces. */
const ERROR_KINDS = 20;
/** What a name is replaced with in an error. */
const HIDDEN = "…";

const StatusSchema = Schema.Literals(["reading", "ready", "failed"]);

const OrgRow = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	name: Schema.String,
	description: Schema.String,
	icon: Schema.NullOr(Schema.String),
	created_at: Schema.Date,
	updated_at: Schema.Date,
	owner_id: Schema.String,
	owner_name: Schema.String,
	owner_email: Schema.String,
	member_count: Schema.Number,
});

const OrgDocumentRow = Schema.Struct({
	id: Schema.String,
	workspace_id: Schema.String,
	name: Schema.String,
	media_type: Schema.String,
	size: Schema.Number,
	status: StatusSchema,
	error: Schema.NullOr(Schema.String),
	created_at: Schema.Date,
	cost_usd: Schema.NullOr(Schema.Number),
	...ProgressFields,
});

const CountRow = Schema.Struct({ count: Schema.Number });
const StatusRow = Schema.Struct({ status: StatusSchema, documents: Schema.Number, cost_usd: Schema.Number });
/** The names here are read only to cut them out of the error. */
const FailedRow = Schema.Struct({ error: Schema.NullOr(Schema.String), names: Schema.Array(Schema.NullOr(Schema.String)) });

// A document's cost: every model call of its indexing, also the billed tries of a batch that failed (log.ts).
const DOCUMENT_COST = `(select sum(r.cost_usd) from runs r where ${DOCUMENT_RUNS} = d.id)`;

export class AdminWorkspaces extends Context.Service<
	AdminWorkspaces,
	{
		/** GET /api/admin/workspaces. */
		readonly report: Effect.Effect<WorkspacesReport, SqlError>;
		/** One document's indexing log, in a workspace open to everyone only: none for a private, deleted or unknown one. */
		readonly documentLog: (workspaceId: string, documentId: string) => Effect.Effect<Option.Option<DocumentLog>, SqlError>;
	}
>()("ponder/workspaces/AdminWorkspaces") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const store = documentStore(sql, yield* ObjectStore.ObjectStore);
	const log = indexLog(sql);

	const findOrg = SqlSchema.findAll({
		Request: Schema.Void,
		Result: OrgRow,
		execute: () => sql`
			select w.id, w.slug, w.name, w.description, w.icon, w.created_at, w.updated_at, w.owner_id,
				coalesce(u.name, '') as owner_name, coalesce(u.email, '') as owner_email,
				(select count(*)::int from workspace_members m where m.workspace_id = w.id) as member_count
			from workspaces w left join users u on u.id = w.owner_id
			where w.org_access <> 'none' and w.deleted_at is null
			order by lower(w.name), w.id`,
	});
	const findOrgDocuments = SqlSchema.findAll({
		Request: Schema.Void,
		Result: OrgDocumentRow,
		execute: () => sql`
			select d.id, d.workspace_id, d.name, d.media_type, d.size, d.status, d.error, d.created_at,
				${sql.literal(DOCUMENT_COST)}::float8 as cost_usd, ${sql.literal(PROGRESS_COLUMNS)}
			from workspace_documents d join workspaces w on w.id = d.workspace_id
			where w.org_access <> 'none' and w.deleted_at is null
			order by d.created_at, d.id`,
	});
	const countPrivate = SqlSchema.findOne({
		Request: Schema.Void,
		Result: CountRow,
		execute: () => sql`select count(*)::int as count from workspaces where org_access = 'none' and deleted_at is null`,
	});
	const findPrivateStatuses = SqlSchema.findAll({
		Request: Schema.Void,
		Result: StatusRow,
		execute: () => sql`
			select d.status, count(*)::int as documents, coalesce(sum(${sql.literal(DOCUMENT_COST)}), 0)::float8 as cost_usd
			from workspace_documents d join workspaces w on w.id = d.workspace_id
			where w.org_access = 'none' and w.deleted_at is null
			group by d.status`,
	});
	const findPrivateFailures = SqlSchema.findAll({
		Request: Schema.Void,
		Result: FailedRow,
		execute: () => sql`
			select d.error, array[d.name, w.name, u.name, u.email] as names
			from workspace_documents d join workspaces w on w.id = d.workspace_id left join users u on u.id = w.owner_id
			where w.org_access = 'none' and w.deleted_at is null and d.status = 'failed'`,
	});
	const isOrgWorkspace = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: CountRow,
		execute: (workspaceId) => sql`select 1 as count from workspaces where id = ${workspaceId} and org_access <> 'none' and deleted_at is null`,
	});

	const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) => effect.pipe(Effect.catchTags({ SchemaError: Effect.die }));

	const orgWorkspaces = Effect.gen(function* () {
		const [workspaces, documents] = yield* decoded(Effect.all([findOrg(undefined), findOrgDocuments(undefined)], { concurrency: "unbounded" }));
		return workspaces.map((row) => orgWorkspace(row, documents.filter((document) => document.workspace_id === row.id)));
	});

	const privateSummary = Effect.gen(function* () {
		const [count, statuses, failures] = yield* Effect.all([countPrivate(undefined), findPrivateStatuses(undefined), findPrivateFailures(undefined)], {
			concurrency: "unbounded",
		}).pipe(Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
		const documents: Record<DocumentStatus, number> = { reading: 0, ready: 0, failed: 0 };
		for (const row of statuses) documents[row.status] = row.documents;
		const costUsd = round(statuses.reduce((sum, row) => sum + row.cost_usd, 0));
		return { workspaces: count.count, documents, costUsd, errors: errorCounts(failures) } satisfies PrivateSummary;
	});

	const report = Effect.all({ org: orgWorkspaces, private: privateSummary }, { concurrency: "unbounded" }).pipe(Effect.withSpan("AdminWorkspaces.report"));

	const documentLog = Effect.fn("AdminWorkspaces.documentLog")(function* (workspaceId: string, documentId: string) {
		if (Option.isNone(yield* decoded(isOrgWorkspace(workspaceId)))) return Option.none<DocumentLog>();
		const found = yield* store.find(workspaceId, documentId);
		if (Option.isNone(found)) return Option.none<DocumentLog>();
		return Option.some({ document: summaryOf(found.value), steps: yield* log.read(found.value.id) });
	});

	return AdminWorkspaces.of({ report, documentLog });
});

export const layer = Layer.effect(AdminWorkspaces, make);

function orgWorkspace(row: typeof OrgRow.Type, documents: ReadonlyArray<typeof OrgDocumentRow.Type>): OrgWorkspace {
	const costs = documents.flatMap((document) => (document.cost_usd === null ? [] : [document.cost_usd]));
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		icon: row.icon,
		owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
		memberCount: row.member_count,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
		documents: documents.map((document) => ({
			id: document.id,
			name: document.name,
			mediaType: document.media_type,
			size: document.size,
			status: document.status,
			error: document.error,
			createdAt: document.created_at.toISOString(),
			progress: progressOf(document),
			costUsd: document.cost_usd === null ? null : round(document.cost_usd),
		})),
		costUsd: costs.length ? round(costs.reduce((sum, cost) => sum + cost, 0)) : null,
	};
}

/** Each error once, with how many documents have it, the names cut out. */
function errorCounts(failures: ReadonlyArray<typeof FailedRow.Type>) {
	const counts = new Map<string, number>();
	for (const failure of failures) {
		const error = withoutNames(failure.error ?? "No reason was kept.", failure.names);
		counts.set(error, (counts.get(error) ?? 0) + 1);
	}
	return [...counts]
		.map(([error, documents]) => ({ error, documents }))
		.sort((a, b) => b.documents - a.documents || a.error.localeCompare(b.error))
		.slice(0, ERROR_KINDS);
}

/**
 * The text with each name in it replaced, in any case. Longest first, so a name inside
 * another is not left half-cut. Names of one or two letters stay: they would cut words.
 */
export function withoutNames(text: string, names: ReadonlyArray<string | null>) {
	const cut = names.filter((name): name is string => !!name && name.trim().length >= 3).sort((a, b) => b.length - a.length);
	return cut.reduce((result, name) => result.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), HIDDEN), text);
}

function round(usd: number) {
	return Math.round(usd * 1e6) / 1e6;
}
