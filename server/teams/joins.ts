import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type * as AdminEvents from "../admin/AdminEvents.ts";
import { lockInvitesOf, normalize } from "../people/Invites.ts";
import { decodeRows } from "../runtime/Database.ts";
import { TeamPlaceRow } from "./rows.ts";

/**
 * A person's first sign-in, by link, by code or with Microsoft (auth/Auth.ts, after it
 * makes the account): each team that invited their email gets them as a member, with the
 * role of the invite. The invites go. An archived team's invite applies too, so Restore
 * brings it all back (docs/teams-plan.md).
 *
 * Each team joined goes to the activity log as "add-team-member", with the person as the
 * actor and `byInvite`: nobody added them just now.
 */
export const joinInvitedTeams = (sql: PgClient.PgClient, events: AdminEvents.AdminEvents["Service"], user: { id: string; email: string }) =>
	sql.withTransaction(
		Effect.gen(function* () {
			const email = normalize(user.email);
			// An invite that is being made now waits for this, or this for it: none is lost.
			yield* lockInvitesOf(sql, email);
			const joined = yield* sql`
				with gone as (delete from team_invites where email = ${email} returning team_id, role, invited_by),
				added as (
					insert into team_members (team_id, user_id, role, added_by)
					select team_id, ${user.id}, role, invited_by from gone
					on conflict (team_id, user_id) do nothing
					returning team_id, role)
				select teams.id as team, teams.name, added.role from added join teams on teams.id = added.team_id order by teams.name`.pipe(decodeRows(TeamPlaceRow));
			for (const { team, name, role } of joined) {
				yield* events.record({ actor: { id: user.id, email }, action: "add-team-member", target: user.id, after: { team, name, role, byInvite: true } });
			}
		}),
	).pipe(Effect.withSpan("Teams.joinInvitedTeams"));
