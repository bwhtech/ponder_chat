import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";

/**
 * A person's first sign-in, by link, by code or with Microsoft (auth/Auth.ts, after it
 * makes the account): each team that invited their email gets them as a member, with the
 * role of the invite. The invites go. An archived team's invite applies too, so Restore
 * brings it all back (docs/teams-plan.md).
 */
export const joinInvitedTeams = (sql: PgClient.PgClient, user: { id: string; email: string }) =>
	sql.withTransaction(
		Effect.gen(function* () {
			const email = user.email.trim().toLowerCase();
			yield* sql`
				insert into team_members (team_id, user_id, role, added_by)
				select team_id, ${user.id}, role, invited_by from team_invites where email = ${email}
				on conflict (team_id, user_id) do nothing`;
			yield* sql`delete from team_invites where email = ${email}`;
		}),
	).pipe(Effect.withSpan("Teams.joinInvitedTeams"));
