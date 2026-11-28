import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * The SQL that Teams.ts reads with. Rows that do not decode are bugs: defects.
 */
const RoleSchema = Schema.Literals(["member", "admin"]);

/** What the rules of access.ts are decided from: the team, and the person's place in it. */
const FactsRow = Schema.Struct({
	archived: Schema.Boolean,
	name: Schema.String,
	admins: Schema.Number,
	role: Schema.NullOr(RoleSchema),
	user_role: Schema.NullOr(Schema.String),
});

const SummaryRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.String,
	archived: Schema.Boolean,
	member_count: Schema.Number,
	admin_count: Schema.Number,
	invite_count: Schema.Number,
});

const TeamRow = Schema.Struct({ id: Schema.String, name: Schema.String, description: Schema.String, archived: Schema.Boolean, created_at: Schema.Date });
const MemberRow = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String, role: RoleSchema, added_at: Schema.Date });
const InviteRow = Schema.Struct({ email: Schema.String, role: RoleSchema, invited_by: Schema.String, created_at: Schema.Date });
const PersonRow = Schema.Struct({ email: Schema.String, banned: Schema.Boolean, role: Schema.NullOr(RoleSchema) });
const NameRow = Schema.Struct({ name: Schema.String, email: Schema.String });

export type FactsRow = typeof FactsRow.Type;
export type SummaryRow = typeof SummaryRow.Type;
export type TeamRow = typeof TeamRow.Type;
export type MemberRow = typeof MemberRow.Type;
export type InviteRow = typeof InviteRow.Type;

export type Rows = {
	/** The team and the person's role in it; none when there is no such team. */
	facts: (request: { userId: string; teamId: string }) => Effect.Effect<Option.Option<FactsRow>, SqlError>;
	/** Whether the person is a team admin of an active team. */
	adminsActiveTeam: (userId: string) => Effect.Effect<boolean, SqlError>;
	/** Every team, or only the active ones that the person admins: active first, then by name. */
	summaries: (request: { adminOf: string | null }) => Effect.Effect<ReadonlyArray<SummaryRow>, SqlError>;
	team: (teamId: string) => Effect.Effect<Option.Option<TeamRow>, SqlError>;
	/** By name, or by email for a person with no name, as the page names them. */
	members: (teamId: string) => Effect.Effect<ReadonlyArray<MemberRow>, SqlError>;
	/** Oldest first. */
	invites: (teamId: string) => Effect.Effect<ReadonlyArray<InviteRow>, SqlError>;
	/** A person with an account: their email, whether they are banned, and their role in the team. None without an account. */
	person: (request: { userId: string; teamId: string }) => Effect.Effect<Option.Option<typeof PersonRow.Type>, SqlError>;
	/** A person's name ('' when they set none) and email, for an email that names them. */
	name: (userId: string) => Effect.Effect<Option.Option<typeof NameRow.Type>, SqlError>;
};

const ADMIN_COUNT = "(select count(*)::int from team_members a where a.team_id = t.id and a.role = 'admin')";

export function rowsOf(sql: PgClient.PgClient): Rows {
	const facts = SqlSchema.findOneOption({
		Request: Schema.Struct({ userId: Schema.String, teamId: Schema.String }),
		Result: FactsRow,
		execute: ({ userId, teamId }) => sql`
			select t.archived_at is not null as archived, t.name, ${sql.literal(ADMIN_COUNT)} as admins, m.role,
				(select role from users where id = ${userId}) as user_role
			from teams t left join team_members m on m.team_id = t.id and m.user_id = ${userId}
			where t.id = ${teamId}`,
	});
	const summaries = SqlSchema.findAll({
		Request: Schema.Struct({ adminOf: Schema.NullOr(Schema.String) }),
		Result: SummaryRow,
		execute: ({ adminOf }) => {
			const mine = adminOf === null ? sql`` : sql`and t.archived_at is null and exists (select 1 from team_members s where s.team_id = t.id and s.user_id = ${adminOf} and s.role = 'admin')`;
			return sql`
				select t.id, t.name, t.description, t.archived_at is not null as archived,
					(select count(*)::int from team_members c where c.team_id = t.id) as member_count,
					${sql.literal(ADMIN_COUNT)} as admin_count,
					(select count(*)::int from team_invites i where i.team_id = t.id) as invite_count
				from teams t
				where true ${mine}
				order by t.archived_at is not null, lower(t.name)`;
		},
	});
	const team = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: TeamRow,
		execute: (teamId) => sql`select id, name, description, archived_at is not null as archived, created_at from teams where id = ${teamId}`,
	});
	const members = SqlSchema.findAll({
		Request: Schema.String,
		Result: MemberRow,
		execute: (teamId) => sql`
			select u.id, coalesce(u.name, '') as name, u.email, m.role, m.added_at
			from team_members m join users u on u.id = m.user_id
			where m.team_id = ${teamId}
			order by lower(coalesce(nullif(u.name, ''), u.email)), lower(u.email)`,
	});
	const invites = SqlSchema.findAll({
		Request: Schema.String,
		Result: InviteRow,
		// Who invited, by name, else by email: an account that is gone keeps its id.
		execute: (teamId) => sql`
			select i.email, i.role, coalesce(nullif(u.name, ''), u.email, i.invited_by) as invited_by, i.created_at
			from team_invites i left join users u on u.id = i.invited_by
			where i.team_id = ${teamId}
			order by i.created_at, i.email`,
	});
	const person = SqlSchema.findOneOption({
		Request: Schema.Struct({ userId: Schema.String, teamId: Schema.String }),
		Result: PersonRow,
		execute: ({ userId, teamId }) => sql`
			select u.email, u.banned is true as banned, m.role
			from users u left join team_members m on m.user_id = u.id and m.team_id = ${teamId}
			where u.id = ${userId}`,
	});

	const name = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: NameRow,
		execute: (userId) => sql`select coalesce(name, '') as name, email from users where id = ${userId}`,
	});
	const adminsActiveTeam = (userId: string) =>
		Effect.map(
			sql`select 1 from team_members m join teams t on t.id = m.team_id where m.user_id = ${userId} and m.role = 'admin' and t.archived_at is null limit 1`,
			(found) => found.length > 0,
		);

	const decoded = <A, E, R>(effect: Effect.Effect<A, E | Schema.SchemaError, R>) => effect.pipe(Effect.catchTags({ SchemaError: Effect.die }));
	return {
		facts: (request) => decoded(facts(request)),
		adminsActiveTeam,
		summaries: (request) => decoded(summaries(request)),
		team: (teamId) => decoded(team(teamId)),
		members: (teamId) => decoded(members(teamId)),
		invites: (teamId) => decoded(invites(teamId)),
		person: (request) => decoded(person(request)),
		name: (userId) => decoded(name(userId)),
	};
}
