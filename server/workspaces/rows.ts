import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Member, WorkspaceTeam } from "./Workspaces.ts";

/**
 * The SQL that Workspaces.ts reads with. Rows that do not decode are bugs: defects.
 * A deleted workspace is never read here.
 */
const OrgAccessSchema = Schema.Literals(["none", "ask"]);
const MemberAccessSchema = Schema.Literals(["ask", "edit"]);

/** What access is decided from (access.ts), with the person's role. */
const FactsRow = Schema.Struct({
	org_access: OrgAccessSchema,
	owner_id: Schema.String,
	member: Schema.NullOr(MemberAccessSchema),
	team: Schema.NullOr(MemberAccessSchema),
	role: Schema.NullOr(Schema.String),
});

const SummaryRow = Schema.Struct({
	id: Schema.String,
	slug: Schema.String,
	org_access: OrgAccessSchema,
	owner_id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	icon: Schema.NullOr(Schema.String),
	/** To the microsecond, as the list is ordered (CREATED_AT). */
	created_at: Schema.String,
	updated_at: Schema.Date,
	member: Schema.NullOr(MemberAccessSchema),
	team: Schema.NullOr(MemberAccessSchema),
	member_count: Schema.Number,
	team_count: Schema.Number,
});

/** A row of the person's list: a summary, and whether they pinned it. */
const ListRow = Schema.Struct({ ...SummaryRow.fields, pinned: Schema.Boolean });

const DetailRow = Schema.Struct({
	...SummaryRow.fields,
	instructions: Schema.String,
	owner_name: Schema.String,
	owner_email: Schema.String,
});

const MemberRow = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String, access: MemberAccessSchema });
const TeamRow = Schema.Struct({ id: Schema.String, name: Schema.String, member_count: Schema.Number, access: MemberAccessSchema, archived: Schema.Boolean });
const IdRow = Schema.Struct({ id: Schema.String });

export type SummaryRow = typeof SummaryRow.Type;
export type ListRow = typeof ListRow.Type;
export type DetailRow = typeof DetailRow.Type;

export type Rows = {
	facts: (request: { userId: string; workspaceId: string }) => Effect.Effect<Option.Option<typeof FactsRow.Type>, SqlError>;
	/** The workspaces the person can use: the ones they pinned first, then the newest made first (the index workspaces_created). */
	summaries: (userId: string) => Effect.Effect<ReadonlyArray<ListRow>, SqlError>;
	detail: (workspaceId: string) => Effect.Effect<Option.Option<DetailRow>, SqlError>;
	/** The id of the workspace with this id or slug, not deleted. */
	idOf: (idOrSlug: string) => Effect.Effect<Option.Option<string>, SqlError>;
	members: (workspaceId: string) => Effect.Effect<Member[], SqlError>;
	/** The teams added, archived ones too, by name. */
	teams: (workspaceId: string) => Effect.Effect<WorkspaceTeam[], SqlError>;

	/** The ids among these that have an account. */
	existing: (userIds: string[]) => Effect.Effect<ReadonlyArray<string>, SqlError>;
};

/**
 * When it was made, to the microsecond, in UTC ISO 8601 text: the list's order (`created_at desc`),
 * which the page sorts again after a pin. A Date would keep only the millisecond, and two
 * workspaces made in the same one could swap.
 */
const CREATED_AT = `to_char(w.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
const MEMBER_COUNT = "(select count(*)::int from workspace_members c where c.workspace_id = w.id) as member_count";
/** The active teams added: an archived team gives no access. */
const TEAM_COUNT = "(select count(*)::int from workspace_teams g join teams t on t.id = g.team_id where g.workspace_id = w.id and t.archived_at is null) as team_count";

/**
 * The highest grant of the person's active teams, per workspace. 'edit' sorts after 'ask',
 * so max() is the highest. From the person's memberships (team_members_user), then their
 * teams' grants (workspace_teams_team).
 */
const teamGrants = (sql: PgClient.PgClient, userId: string) => sql`
	select g.workspace_id, max(g.access) as access
	from team_members tm
		join teams t on t.id = tm.team_id and t.archived_at is null
		join workspace_teams g on g.team_id = tm.team_id
	where tm.user_id = ${userId}
	group by g.workspace_id`;

export function rowsOf(sql: PgClient.PgClient): Rows {
	const facts = SqlSchema.findOneOption({
		Request: Schema.Struct({ userId: Schema.String, workspaceId: Schema.String }),
		Result: FactsRow,
		execute: ({ userId, workspaceId }) => sql`
			select w.org_access, w.owner_id, m.access as member, g.access as team, (select role from users where id = ${userId}) as role
			from workspaces w
				left join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId}
				left join (${teamGrants(sql, userId)}) g on g.workspace_id = w.id
			where w.id = ${workspaceId} and w.deleted_at is null`,
	});
	const summaries = SqlSchema.findAll({
		Request: Schema.String,
		Result: ListRow,
		// A pin only counts on a workspace the person can still use: the join adds to the rows
		// the person can use, and never adds a row.
		execute: (userId) => sql`
			select w.id, w.slug, w.org_access, w.owner_id, w.name, w.description, w.icon, ${sql.literal(CREATED_AT)}, w.updated_at, m.access as member, g.access as team,
				${sql.literal(MEMBER_COUNT)}, ${sql.literal(TEAM_COUNT)}, p.user_id is not null as pinned
			from workspaces w
				left join workspace_members m on m.workspace_id = w.id and m.user_id = ${userId}
				left join (${teamGrants(sql, userId)}) g on g.workspace_id = w.id
				left join workspace_pins p on p.workspace_id = w.id and p.user_id = ${userId}
			where w.deleted_at is null and (w.org_access <> 'none' or w.owner_id = ${userId} or m.user_id is not null or g.access is not null)
			order by pinned desc, w.created_at desc, w.id desc`,
	});
	const detail = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: DetailRow,
		execute: (workspaceId) => sql`
			select w.id, w.slug, w.org_access, w.owner_id, w.name, w.description, w.instructions, w.icon, ${sql.literal(CREATED_AT)}, w.updated_at,
				null as member, null as team, ${sql.literal(MEMBER_COUNT)}, ${sql.literal(TEAM_COUNT)},
				coalesce(u.name, '') as owner_name, coalesce(u.email, '') as owner_email
			from workspaces w left join users u on u.id = w.owner_id
			where w.id = ${workspaceId} and w.deleted_at is null`,
	});
	const idOf = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: IdRow,
		// An id wins over a slug that happens to spell it.
		execute: (key) => sql`
			select id from workspaces
			where (id = ${key} or slug = ${key}) and deleted_at is null
			order by (id = ${key}) desc limit 1`,
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
	const teams = SqlSchema.findAll({
		Request: Schema.String,
		Result: TeamRow,
		execute: (workspaceId) => sql`
			select t.id, t.name, (select count(*)::int from team_members c where c.team_id = t.id) as member_count, g.access, t.archived_at is not null as archived
			from workspace_teams g join teams t on t.id = g.team_id
			where g.workspace_id = ${workspaceId}
			order by lower(t.name), t.id`,
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
		idOf: (key) => decoded(idOf(key)).pipe(Effect.map(Option.map((row) => row.id))),
		members: (workspaceId) => decoded(members(workspaceId)).pipe(Effect.map((rows) => rows.map((row): Member => ({ ...row })))),
		teams: (workspaceId) =>
			decoded(teams(workspaceId)).pipe(
				Effect.map((rows) => rows.map((row): WorkspaceTeam => ({ id: row.id, name: row.name, memberCount: row.member_count, access: row.access, archived: row.archived }))),
			),
		existing: (userIds) => (userIds.length ? decoded(existing(userIds)).pipe(Effect.map((rows) => rows.map((row) => row.id))) : Effect.succeed([])),
	};
}
