import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/**
 * Every table of teams (docs/teams-plan.md, "Data model"), made at once, so later work does
 * not change this migration. Idempotent. After Auth (users), Workspaces (workspaces) and
 * Invites (allowed_emails).
 */
export const migrateTeams = (sql: PgClient.PgClient) =>
	Effect.gen(function* () {
		yield* sql`
			create table if not exists teams (
				id text primary key,
				name text not null,
				description text not null default '',
				created_by text not null,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now(),
				archived_at timestamptz
			)`;
		// Two teams called "HR" in the share picker could not be told apart.
		yield* sql`create unique index if not exists teams_name on teams (lower(name))`;
		yield* sql`
			create table if not exists team_members (
				team_id text not null references teams (id) on delete cascade,
				user_id text not null references users (id) on delete cascade,
				role text not null check (role in ('member', 'admin')),
				added_by text not null,
				added_at timestamptz not null default now(),
				primary key (team_id, user_id)
			)`;
		yield* sql`create index if not exists team_members_user on team_members (user_id)`;
		// An email with no account yet, in lowercase. It becomes a team_members row at the first sign-in.
		yield* sql`
			create table if not exists team_invites (
				team_id text not null references teams (id) on delete cascade,
				email text not null,
				role text not null check (role in ('member', 'admin')),
				invited_by text not null,
				created_at timestamptz not null default now(),
				primary key (team_id, email)
			)`;
		yield* sql`create index if not exists team_invites_email on team_invites (email)`;
		// allowed_emails.team_only is made by people/Invites.ts, which owns that table.
		yield* sql`
			create table if not exists workspace_teams (
				workspace_id text not null references workspaces (id) on delete cascade,
				team_id text not null references teams (id) on delete cascade,
				access text not null check (access in ('ask', 'edit')),
				added_by text not null,
				added_at timestamptz not null default now(),
				primary key (workspace_id, team_id)
			)`;
		yield* sql`create index if not exists workspace_teams_team on workspace_teams (team_id)`;
	});
