import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Member } from "./Workspaces.ts";

/**
 * The SQL that Workspaces.ts reads with. Rows that do not decode are bugs: defects.
 * A deleted workspace is never read here.
 */
const KindSchema = Schema.Literals(["org", "private"]);
const MemberAccessSchema = Schema.Literals(["ask", "edit"]);

/** What access is decided from (access.ts), with the person's role. */
const FactsRow = Schema.Struct({ kind: KindSchema, owner_id: Schema.String, member: Schema.NullOr(MemberAccessSchema), role: Schema.NullOr(Schema.String) });

const SummaryRow = Schema.Struct({
	id: Schema.String,
	kind: KindSchema,
	owner_id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	icon: Schema.NullOr(Schema.String),
	updated_at: Schema.Date,
	member: Schema.NullOr(MemberAccessSchema),
	member_count: Schema.Number,
});

const DetailRow = Schema.Struct({
	...SummaryRow.fields,
	instructions: Schema.String,
	created_at: Schema.Date,
	owner_name: Schema.String,
	owner_email: Schema.String,
});

const MemberRow = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String, access: MemberAccessSchema });
const IdRow = Schema.Struct({ id: Schema.String });

export type SummaryRow = typeof SummaryRow.Type;
export type DetailRow = typeof DetailRow.Type;

export type Rows = {
	facts: (request: { userId: string; workspaceId: string }) => Effect.Effect<Option.Option<typeof FactsRow.Type>, SqlError>;
	summaries: (userId: string) => Effect.Effect<ReadonlyArray<SummaryRow>, SqlError>;
	detail: (workspaceId: string) => Effect.Effect<Option.Option<DetailRow>, SqlError>;
	members: (workspaceId: string) => Effect.Effect<Member[], SqlError>;
	/** The ids among these that have an account. */
	existing: (userIds: string[]) => Effect.Effect<ReadonlyArray<string>, SqlError>;
};

const MEMBER_COUNT = "(select count(*)::int from workspace_members c where c.workspace_id = w.id) as member_count";

export function rowsOf(sql: PgClient.PgClient): Rows {
	const facts = SqlSchema.findOneOption({
		Request: Schema.Struct({ userId: Schema.String, workspaceId: Schema.String }),
		Result: FactsRow,
		execute: ({ userId, workspaceId }) => sql`
			select w.kind, w.owner_id, m.access as member, (select role from users where id = ${userId}) as role
			from workspaces w left join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId}
			where w.id = ${workspaceId} and w.deleted_at is null`,
	});
	const summaries = SqlSchema.findAll({
		Request: Schema.String,
		Result: SummaryRow,
		execute: (userId) => sql`
			select w.id, w.kind, w.owner_id, w.name, w.description, w.icon, w.updated_at, m.access as member, ${sql.literal(MEMBER_COUNT)}
			from workspaces w left join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId}
			where w.deleted_at is null and (w.kind = 'org' or w.owner_id = ${userId} or m.user_id is not null)`,
	});
	const detail = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: DetailRow,
		execute: (workspaceId) => sql`
			select w.id, w.kind, w.owner_id, w.name, w.description, w.instructions, w.icon, w.created_at, w.updated_at,
				null as member, ${sql.literal(MEMBER_COUNT)},
				coalesce(u.name, '') as owner_name, coalesce(u.email, '') as owner_email
			from workspaces w left join users u on u.id = w.owner_id
			where w.id = ${workspaceId} and w.deleted_at is null`,
	});
	const members = SqlSchema.findAll({
		Request: Schema.String,
		Result: MemberRow,
		execute: (workspaceId) => sql`
			select u.id, coalesce(u.name, '') as name, u.email, m.access
			from workspace_members m join users u on u.id = m.user_id
			where m.workspace_id = ${workspaceId}
			order by lower(coalesce(u.name, '')), lower(u.email)`,
	});
	const existing = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: IdRow,
		execute: (userIds) => sql`select id from users where id = any(${userIds})`,
	});

	const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) => effect.pipe(Effect.catchTags({ SchemaError: Effect.die }));
	return {
		facts: (request) => decoded(facts(request)),
		summaries: (userId) => decoded(summaries(userId)),
		detail: (workspaceId) => decoded(detail(workspaceId)),
		members: (workspaceId) => decoded(members(workspaceId)).pipe(Effect.map((rows) => rows.map((row): Member => ({ ...row })))),
		existing: (userIds) => (userIds.length ? decoded(existing(userIds)).pipe(Effect.map((rows) => rows.map((row) => row.id))) : Effect.succeed([])),
	};
}
