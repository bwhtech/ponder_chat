import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import type * as AdminEvents from "../admin/AdminEvents.ts";
import { lockInvitesOf } from "../people/Invites.ts";
import { canDelete, canOrganise, type TeamViewer } from "./access.ts";
import { type Actor, type TeamDetail, type TeamNotFound, TeamRefused } from "./model.ts";
import type { FactsRow } from "./rows.ts";

/**
 * Archive, restore and delete (docs/teams-plan.md): org admins only. An archived team keeps
 * its rows, but its grants give no access (workspaces/rows.ts) and nobody changes its
 * people (access.ts). Delete takes an archived team with its members, invites and grants.
 *
 * Each locks the team's row (`lockTeam`), so a share, an invite or a member change that
 * comes at the same time waits, then sees the team as this left it. Delete takes the locks
 * of its invites' emails before the row, in the order of Teams.ts.
 */
export type Lifecycle = {
	archive: (actor: Actor, teamId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
	restore: (actor: Actor, teamId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
	remove: (actor: Actor, teamId: string) => Effect.Effect<void, TeamNotFound | TeamRefused | SqlError>;
};

/** Delete found an invite that came after it locked the emails: it starts again. */
class InvitesMoved extends Schema.TaggedError<InvitesMoved>()("InvitesMoved", {}) {}

type Needs = {
	sql: PgClient.PgClient;
	events: AdminEvents.AdminEvents["Service"];
	/** Locks the team's row until the transaction ends, then reads the person's facts. */
	lockTeam: (actor: Actor, teamId: string) => Effect.Effect<FactsRow, TeamNotFound | SqlError>;
	viewerOf: (facts: FactsRow) => TeamViewer;
	get: (actor: Actor, teamId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
};

export function lifecycleOf({ sql, events, lockTeam, viewerOf, get }: Needs): Lifecycle {
	/** Archives or restores. A team already so changes nothing. */
	const setArchived = (archived: boolean) =>
		Effect.fnUntraced(function* (actor: Actor, teamId: string) {
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const facts = yield* lockTeam(actor, teamId);
					if (!canOrganise(viewerOf(facts))) return yield* new TeamRefused({ reason: "needs-org-admin" });
					if (facts.archived === archived) return;
					yield* sql`update teams set archived_at = case when ${archived} then now() end, updated_at = now() where id = ${teamId}`;
					yield* events.record({ actor, action: archived ? "archive-team" : "restore-team", after: { team: teamId, name: facts.name } });
				}),
			);
			return yield* get(actor, teamId);
		});

	const remove = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		yield* removeOnce(actor, teamId).pipe(
			Effect.retry({ while: (error) => error._tag === "InvitesMoved", times: 5 }),
			Effect.catchTag("InvitesMoved", () => Effect.die(new Error(`Team ${teamId}: its invites kept changing during delete.`))),
		);
	});

	const removeOnce = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				// Sorted, so two deletes take the same emails' locks in the same order.
				const emails = yield* inviteEmails(teamId);
				for (const email of emails) yield* lockInvitesOf(sql, email);
				const facts = yield* lockTeam(actor, teamId);
				const viewer = viewerOf(facts);
				if (!canOrganise(viewer)) return yield* new TeamRefused({ reason: "needs-org-admin" });
				if (!canDelete(viewer, facts.archived)) return yield* new TeamRefused({ reason: "not-archived" });
				// Archived, so no invite comes now. One may have come before the lock, if the team was
				// restored and archived again meanwhile. Its email's lock would come after the team's,
				// against the order of Teams.ts, so start again instead.
				const now = yield* inviteEmails(teamId);
				if (now.some((each) => !emails.includes(each))) return yield* new InvitesMoved();

				const [counts] = yield* sql<{ members: number; grants: number }>`
					select (select count(*)::int from team_members where team_id = ${teamId}) as members,
						(select count(*)::int from workspace_teams where team_id = ${teamId}) as grants`;
				// Its members, invites and grants go with it (on delete cascade).
				yield* sql`delete from teams where id = ${teamId}`;
				if (now.length > 0) yield* closeWayIn(now);
				yield* events.record({
					actor,
					action: "delete-team",
					before: { team: teamId, name: facts.name, members: counts?.members ?? 0, invites: now.length, grants: counts?.grants ?? 0 },
				});
			}),
		);
	});

	const inviteEmails = (teamId: string) =>
		Effect.map(sql<{ email: string }>`select email from team_invites where team_id = ${teamId} order by email`, (rows) => rows.map((row) => row.email));

	/** As Teams.cancelInvite: the emails that only this team's invites let in may no longer sign in. */
	const closeWayIn = (emails: string[]) => sql`
		delete from allowed_emails a where a.email in ${sql.in(emails)} and a.team_only
		and not exists (select 1 from team_invites i where i.email = a.email)
		and not exists (select 1 from users u where lower(u.email) = a.email)`;

	return { archive: setArchived(true), restore: setArchived(false), remove };
}
