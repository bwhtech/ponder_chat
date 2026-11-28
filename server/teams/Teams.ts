import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as AdminEvents from "../admin/AdminEvents.ts";
import * as Accounts from "../people/Accounts.ts";
import { roleFrom } from "../people/Accounts.ts";
import { pgCode } from "../runtime/Database.ts";
import { canAdminister, canChangePeople, canOrganise, leavesNoAdmin, type TeamRole, type TeamViewer } from "./access.ts";
import { migrateTeams } from "./tables.ts";
import { type FactsRow, type Rows, rowsOf } from "./rows.ts";

/**
 * Teams (docs/teams-plan.md): named groups of people in the org, such as HR. Org admins
 * make and rename them, and name the first team admin. Team admins and org admins add
 * people, remove them and change their roles. A team keeps at least one team admin, unless
 * an org admin decides otherwise (access.ts).
 *
 * Every change to a team locks its row first, in a transaction, and reads the person's
 * role only then. So two admins who change the team at once take turns, and the last-admin
 * rule sees the other's change. Every change goes to the admin activity log.
 */
export type { TeamRole } from "./access.ts";

/** Who asks for a change: their id, and their email for the activity log. */
export type Actor = { id: string; email: string };

/** A row of /admin/teams. */
export type TeamSummary = {
	id: string;
	name: string;
	description: string;
	memberCount: number;
	adminCount: number;
	/** Pending invites: emails with no account yet. */
	inviteCount: number;
	archived: boolean;
};

export type TeamMember = { id: string; name: string; email: string; role: TeamRole; addedAt: string };
export type TeamInvite = { email: string; role: TeamRole; invitedBy: string; createdAt: string };

/** One team (/admin/teams/:id), as an org admin or one of its team admins sees it. */
export type TeamDetail = {
	id: string;
	name: string;
	description: string;
	archived: boolean;
	createdAt: string;
	members: TeamMember[];
	invites: TeamInvite[];
	/** Renames it, and archives, restores or deletes it: org admins. */
	canOrganise: boolean;
	/** Adds and removes people and changes their roles. */
	canChangePeople: boolean;
};

export type NewTeam = { name: string; description: string; adminUserId: string };
export type TeamChanges = { name?: string; description?: string };

/** No such team. Routes answer 404. */
export class TeamNotFound extends Schema.TaggedError<TeamNotFound>()("TeamNotFound", {
	teamId: Schema.String,
}) {
	override get message() {
		return "This team was not found.";
	}
}

const REFUSALS = {
	"needs-org-admin": "Only org admins can do this.",
	"needs-team-admin": "Only this team's admins and org admins can do this.",
	archived: "This team is archived. Restore it to change it.",
	"last-admin": "A team needs at least one team admin. Make someone else a team admin first.",
	banned: "This person is banned, so they can't join a team.",
	"no-account": "That person has no account.",
} as const;

/** The person may not do this to the team. Routes answer 403 with the message ("no-account": 400). */
export class TeamRefused extends Schema.TaggedError<TeamRefused>()("TeamRefused", {
	reason: Schema.Literals(["needs-org-admin", "needs-team-admin", "archived", "last-admin", "banned", "no-account"]),
}) {
	override get message() {
		return REFUSALS[this.reason];
	}
}

/** Another team has this name, in any case. Routes answer 409. */
export class TeamNameTaken extends Schema.TaggedError<TeamNameTaken>()("TeamNameTaken", {}) {
	override get message() {
		return "A team with this name already exists.";
	}
}

export class Teams extends Context.Service<
	Teams,
	{
		/** Every team table (tables.ts). After Auth (users), Workspaces and Invites (allowed_emails). */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Org admins: every team, archived too. Team admins: the active teams they admin. */
		readonly list: (actor: Actor) => Effect.Effect<TeamSummary[], SqlError>;
		/** Org admins only. The first team admin must have an account and not be banned. */
		readonly create: (actor: Actor, input: NewTeam) => Effect.Effect<TeamDetail, TeamRefused | TeamNameTaken | SqlError>;
		/** Name and description: org admins only. */
		readonly update: (actor: Actor, teamId: string, changes: TeamChanges) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | TeamNameTaken | SqlError>;
		/** Org admins and the team's admins. */
		readonly get: (actor: Actor, teamId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
		/** Adds a person with this role, or gives a member this role. Never a banned person. */
		readonly setMember: (actor: Actor, teamId: string, userId: string, role: TeamRole) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
		/** Removes a person, themselves too. Removing someone who is no member changes nothing. */
		readonly removeMember: (actor: Actor, teamId: string, userId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
	}
>()("ponder/teams/Teams") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const accounts = yield* Accounts.Accounts;
	const events = yield* AdminEvents.AdminEvents;
	const rows: Rows = rowsOf(sql);

	const migrate = migrateTeams(sql);

	/** The team's facts for this person, or not found. */
	const factsOf = Effect.fnUntraced(function* (userId: string, teamId: string) {
		const found = yield* rows.facts({ userId, teamId });
		if (Option.isNone(found)) return yield* new TeamNotFound({ teamId });
		return found.value;
	});

	const viewerOf = (facts: FactsRow): TeamViewer => ({ orgAdmin: roleFrom(facts.user_role) === "admin", role: facts.role });

	/** The team as this person sees it. The caller checked that they may. */
	const detail = Effect.fnUntraced(function* (teamId: string, viewer: TeamViewer) {
		const team = Option.getOrThrow(yield* rows.team(teamId));
		const [members, invites] = yield* Effect.all([rows.members(teamId), rows.invites(teamId)]);
		return {
			id: team.id,
			name: team.name,
			description: team.description,
			archived: team.archived,
			createdAt: team.created_at.toISOString(),
			members: members.map((member) => ({ id: member.id, name: member.name, email: member.email, role: member.role, addedAt: member.added_at.toISOString() })),
			invites: invites.map((invite) => ({ email: invite.email, role: invite.role, invitedBy: invite.invited_by, createdAt: invite.created_at.toISOString() })),
			canOrganise: canOrganise(viewer),
			canChangePeople: canChangePeople(viewer, team.archived),
		} satisfies TeamDetail;
	});

	/** The detail as the person sees it after a change: they may have removed themselves. */
	const detailNow = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		return yield* detail(teamId, viewerOf(yield* factsOf(actor.id, teamId)));
	});

	/**
	 * Locks the team's row until the transaction ends, then reads the person's facts: a
	 * change made meanwhile is in before the check. Read committed: a statement that waited
	 * reads the row again, as the other left it.
	 */
	const lockTeam = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		const live = yield* sql`select id from teams where id = ${teamId} for no key update`;
		if (live.length === 0) return yield* new TeamNotFound({ teamId });
		return yield* factsOf(actor.id, teamId);
	});

	/** For a change to the team's people: the facts, when the person may make it. */
	const lockForPeople = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		const facts = yield* lockTeam(actor, teamId);
		const viewer = viewerOf(facts);
		if (!canAdminister(viewer)) return yield* new TeamRefused({ reason: "needs-team-admin" });
		if (!canChangePeople(viewer, facts.archived)) return yield* new TeamRefused({ reason: "archived" });
		return { facts, viewer };
	});

	/** Two teams can't share a name, in any case (the index teams_name). */
	const nameTaken = <A>(effect: Effect.Effect<A, SqlError>) =>
		effect.pipe(Effect.catchTags({ SqlError: (error) => Effect.fail(pgCode(error) === "23505" ? new TeamNameTaken() : error) }));

	const list = Effect.fn("Teams.list")(function* (actor: Actor) {
		const orgAdmin = yield* accounts.isAdmin(actor.id);
		const found = yield* rows.summaries({ adminOf: orgAdmin ? null : actor.id });
		return found.map(
			(row): TeamSummary => ({
				id: row.id,
				name: row.name,
				description: row.description,
				memberCount: row.member_count,
				adminCount: row.admin_count,
				inviteCount: row.invite_count,
				archived: row.archived,
			}),
		);
	});

	const create = Effect.fn("Teams.create")(function* (actor: Actor, input: NewTeam) {
		if (!(yield* accounts.isAdmin(actor.id))) return yield* new TeamRefused({ reason: "needs-org-admin" });
		const id = randomUUID();
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const person = yield* rows.person({ userId: input.adminUserId, teamId: id });
				if (Option.isNone(person)) return yield* new TeamRefused({ reason: "no-account" });
				if (person.value.banned) return yield* new TeamRefused({ reason: "banned" });
				yield* nameTaken(sql`insert into teams (id, name, description, created_by) values (${id}, ${input.name}, ${input.description}, ${actor.id})`);
				yield* sql`insert into team_members (team_id, user_id, role, added_by) values (${id}, ${input.adminUserId}, 'admin', ${actor.id})`;
				yield* events.record({ actor, action: "create-team", target: input.adminUserId, after: { team: id, name: input.name, description: input.description, role: "admin" } });
			}),
		);
		return yield* detail(id, { orgAdmin: true, role: null });
	});

	const update = Effect.fn("Teams.update")(function* (actor: Actor, teamId: string, changes: TeamChanges) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const facts = yield* lockTeam(actor, teamId);
				if (!canOrganise(viewerOf(facts))) return yield* new TeamRefused({ reason: "needs-org-admin" });
				if (facts.archived) return yield* new TeamRefused({ reason: "archived" });
				const team = Option.getOrThrow(yield* rows.team(teamId));
				const before = { name: team.name, description: team.description };
				const after = { name: changes.name ?? before.name, description: changes.description ?? before.description };
				if (after.name === before.name && after.description === before.description) return;
				yield* nameTaken(sql`update teams set name = ${after.name}, description = ${after.description}, updated_at = now() where id = ${teamId}`);
				yield* events.record({ actor, action: "update-team", before: { team: teamId, ...before }, after: { team: teamId, ...after } });
			}),
		);
		return yield* detailNow(actor, teamId);
	});

	const get = Effect.fn("Teams.get")(function* (actor: Actor, teamId: string) {
		const viewer = viewerOf(yield* factsOf(actor.id, teamId));
		if (!canAdminister(viewer)) return yield* new TeamRefused({ reason: "needs-team-admin" });
		return yield* detail(teamId, viewer);
	});

	const setMember = Effect.fn("Teams.setMember")(function* (actor: Actor, teamId: string, userId: string, role: TeamRole) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const { facts, viewer } = yield* lockForPeople(actor, teamId);
				const person = yield* rows.person({ userId, teamId });
				if (Option.isNone(person)) return yield* new TeamRefused({ reason: "no-account" });
				const from = person.value.role;
				if (from === null && person.value.banned) return yield* new TeamRefused({ reason: "banned" });
				if (from === role) return;
				if (leavesNoAdmin(viewer, facts, { from, to: role })) return yield* new TeamRefused({ reason: "last-admin" });
				// A member who stays keeps when and by whom they were added.
				yield* sql`
					insert into team_members (team_id, user_id, role, added_by) values (${teamId}, ${userId}, ${role}, ${actor.id})
					on conflict (team_id, user_id) do update set role = excluded.role`;
				yield* sql`update teams set updated_at = now() where id = ${teamId}`;
				const team = { team: teamId, name: facts.name };
				yield* events.record({
					actor,
					action: from === null ? "add-team-member" : "set-team-role",
					target: userId,
					before: from === null ? null : { ...team, role: from },
					after: { ...team, role },
				});
			}),
		);
		return yield* detailNow(actor, teamId);
	});

	const removeMember = Effect.fn("Teams.removeMember")(function* (actor: Actor, teamId: string, userId: string) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const { facts, viewer } = yield* lockForPeople(actor, teamId);
				const [found] = yield* sql<{ role: TeamRole }>`select role from team_members where team_id = ${teamId} and user_id = ${userId}`;
				if (!found) return;
				if (leavesNoAdmin(viewer, facts, { from: found.role, to: null })) return yield* new TeamRefused({ reason: "last-admin" });
				yield* sql`delete from team_members where team_id = ${teamId} and user_id = ${userId}`;
				yield* sql`update teams set updated_at = now() where id = ${teamId}`;
				yield* events.record({ actor, action: "remove-team-member", target: userId, before: { team: teamId, name: facts.name, role: found.role } });
			}),
		);
		return yield* detailNow(actor, teamId);
	});

	return Teams.of({ migrate, list, create, update, get, setMember, removeMember });
});

export const layer = Layer.effect(Teams, make);
