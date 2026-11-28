import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import * as AdminEvents from "../admin/AdminEvents.ts";
import * as SignInProviders from "../auth/SignInProviders.ts";
import * as Mailer from "../email/Mailer.ts";
import * as Accounts from "../people/Accounts.ts";
import { roleFrom } from "../people/Accounts.ts";
import { pgCode } from "../runtime/Database.ts";
import { canAdminister, canChangePeople, canOrganise, leavesNoAdmin, type TeamRole, type TeamViewer } from "./access.ts";
import { teamEmails } from "./emails.ts";
import {
	type Actor,
	type AdminScope,
	type InviteResult,
	type NewTeam,
	type TeamChanges,
	type TeamDetail,
	type TeamMatch,
	TeamNameTaken,
	TeamNotFound,
	TeamRefused,
	type TeamSummary,
} from "./model.ts";
import { type FactsRow, type Rows, rowsOf } from "./rows.ts";
import { migrateTeams } from "./tables.ts";

/**
 * Teams (docs/teams-plan.md): named groups of people in the org, such as HR. Org admins
 * make and rename them, and name the first team admin. Team admins and org admins add
 * people, invite emails that have no account yet, remove people and change their roles. A
 * team keeps at least one team admin, unless an org admin decides otherwise (access.ts).
 *
 * Every change to a team locks its row first, in a transaction, and reads the person's
 * role only then. So two admins who change the team at once take turns, and the last-admin
 * rule sees the other's change. Every change goes to the admin activity log. The emails go
 * after the commit (emails.ts).
 */
export * from "./model.ts";

export class Teams extends Context.Service<
	Teams,
	{
		/** Every team table (tables.ts). After Auth (users), Workspaces and Invites (allowed_emails). */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** "org" for an org admin, "team" for the admin of an active team, else none. */
		readonly adminScope: (userId: string) => Effect.Effect<Option.Option<AdminScope>, SqlError>;
		/** Org admins: every team, archived too. Team admins: the active teams they admin. */
		readonly list: (actor: Actor) => Effect.Effect<TeamSummary[], SqlError>;
		/** Active teams whose name has this text, without case: at most 20. Any signed-in person. */
		readonly search: (text: string) => Effect.Effect<TeamMatch[], SqlError>;
		/** Org admins only. The first team admin must have an account and not be banned. They get an email. */
		readonly create: (actor: Actor, input: NewTeam) => Effect.Effect<TeamDetail, TeamRefused | TeamNameTaken | SqlError>;
		/** Name and description: org admins only. */
		readonly update: (actor: Actor, teamId: string, changes: TeamChanges) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | TeamNameTaken | SqlError>;
		/** Org admins and the team's admins. */
		readonly get: (actor: Actor, teamId: string) => Effect.Effect<TeamDetail, TeamNotFound | TeamRefused | SqlError>;
		/**
		 * Adds a person with this role, or gives a member this role. Never a banned person. A
		 * person added gets an email. Null when the person demoted themselves.
		 */
		readonly setMember: (actor: Actor, teamId: string, userId: string, role: TeamRole) => Effect.Effect<TeamDetail | null, TeamNotFound | TeamRefused | SqlError>;
		/** Removes a person, themselves too. Removing someone who is no member changes nothing. Null when the person removed themselves. */
		readonly removeMember: (actor: Actor, teamId: string, userId: string) => Effect.Effect<TeamDetail | null, TeamNotFound | TeamRefused | SqlError>;
		/**
		 * A lowercase email: the account with it joins with this role, as setMember. With no
		 * account, the email is invited: it may sign in, and joins at its first sign-in
		 * (joins.ts). A new invite gets the invite email; a second one changes the role. The
		 * team is null when the person invited their own email as a member.
		 */
		readonly invite: (actor: Actor, teamId: string, email: string, role: TeamRole) => Effect.Effect<InviteResult, TeamNotFound | TeamRefused | SqlError>;
		/**
		 * Cancels the team's invite of a lowercase email. The email may then no longer sign in,
		 * unless an org admin invited it or another team's invite holds it. No invite: no change.
		 */
		readonly cancelInvite: (actor: Actor, teamId: string, email: string) => Effect.Effect<TeamDetail | null, TeamNotFound | TeamRefused | SqlError>;
	}
>()("ponder/teams/Teams") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const accounts = yield* Accounts.Accounts;
	const events = yield* AdminEvents.AdminEvents;
	const rows: Rows = rowsOf(sql);
	const emails = teamEmails(yield* Mailer.Mailer, yield* SignInProviders.SignInProviders, rows);

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

	/**
	 * The detail as the person sees it after a change, or null when the change took away their
	 * right to see it: a team admin who removed or demoted themselves.
	 */
	const detailNow = Effect.fnUntraced(function* (actor: Actor, teamId: string) {
		const viewer = viewerOf(yield* factsOf(actor.id, teamId));
		return canAdminister(viewer) ? yield* detail(teamId, viewer) : null;
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

	const adminScope = Effect.fn("Teams.adminScope")(function* (userId: string) {
		if (yield* accounts.isAdmin(userId)) return Option.some<AdminScope>("org");
		return (yield* rows.adminsActiveTeam(userId)) ? Option.some<AdminScope>("team") : Option.none<AdminScope>();
	});

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

	const search = Effect.fn("Teams.search")(function* (text: string) {
		// The text is matched as it is: % and _ in it are not wildcards (as Accounts.search).
		const pattern = `%${text.trim().replace(/[\\%_]/g, (special) => `\\${special}`)}%`;
		const found = yield* rows.matches(pattern);
		return found.map((row): TeamMatch => ({ id: row.id, name: row.name, memberCount: row.member_count }));
	});

	const create = Effect.fn("Teams.create")(function* (actor: Actor, input: NewTeam) {
		if (!(yield* accounts.isAdmin(actor.id))) return yield* new TeamRefused({ reason: "needs-org-admin" });
		const id = randomUUID();
		const email = yield* sql.withTransaction(
			Effect.gen(function* () {
				const person = yield* rows.person({ userId: input.adminUserId, teamId: id });
				if (Option.isNone(person)) return yield* new TeamRefused({ reason: "no-account" });
				if (person.value.banned) return yield* new TeamRefused({ reason: "banned" });
				yield* nameTaken(sql`insert into teams (id, name, description, created_by) values (${id}, ${input.name}, ${input.description}, ${actor.id})`);
				yield* sql`insert into team_members (team_id, user_id, role, added_by) values (${id}, ${input.adminUserId}, 'admin', ${actor.id})`;
				yield* events.record({ actor, action: "create-team", target: input.adminUserId, after: { team: id, name: input.name, description: input.description, role: "admin" } });
				return person.value.email;
			}),
		);
		yield* emails.added(email, actor.origin, { team: input.name, byUserId: actor.id, admin: true });
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
		return yield* get(actor, teamId);
	});

	const get = Effect.fn("Teams.get")(function* (actor: Actor, teamId: string) {
		const viewer = viewerOf(yield* factsOf(actor.id, teamId));
		if (!canAdminister(viewer)) return yield* new TeamRefused({ reason: "needs-team-admin" });
		return yield* detail(teamId, viewer);
	});

	/**
	 * In lockForPeople's transaction: adds the person with this role, or gives them this role.
	 * Their email when they were not in the team, for the email after the commit.
	 */
	const putMember = Effect.fnUntraced(function* (actor: Actor, locked: { facts: FactsRow; viewer: TeamViewer }, teamId: string, userId: string, role: TeamRole) {
		const person = yield* rows.person({ userId, teamId });
		if (Option.isNone(person)) return yield* new TeamRefused({ reason: "no-account" });
		const from = person.value.role;
		if (from === null && person.value.banned) return yield* new TeamRefused({ reason: "banned" });
		if (from === role) return Option.none<string>();
		if (leavesNoAdmin(locked.viewer, locked.facts, { from, to: role })) return yield* new TeamRefused({ reason: "last-admin" });
		// A member who stays keeps when and by whom they were added.
		yield* sql`
			insert into team_members (team_id, user_id, role, added_by) values (${teamId}, ${userId}, ${role}, ${actor.id})
			on conflict (team_id, user_id) do update set role = excluded.role`;
		yield* sql`update teams set updated_at = now() where id = ${teamId}`;
		const team = { team: teamId, name: locked.facts.name };
		yield* events.record({
			actor,
			action: from === null ? "add-team-member" : "set-team-role",
			target: userId,
			before: from === null ? null : { ...team, role: from },
			after: { ...team, role },
		});
		return from === null ? Option.some(person.value.email) : Option.none<string>();
	});

	/** The email to a person added to the team, once the change is in. */
	const tellAdded = (actor: Actor, teamName: string, role: TeamRole) => (added: Option.Option<string>) =>
		Option.isSome(added) ? emails.added(added.value, actor.origin, { team: teamName, byUserId: actor.id, admin: role === "admin" }) : Effect.void;

	const setMember = Effect.fn("Teams.setMember")(function* (actor: Actor, teamId: string, userId: string, role: TeamRole) {
		const { name, added } = yield* sql.withTransaction(
			Effect.gen(function* () {
				const locked = yield* lockForPeople(actor, teamId);
				return { name: locked.facts.name, added: yield* putMember(actor, locked, teamId, userId, role) };
			}),
		);
		yield* tellAdded(actor, name, role)(added);
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

	/** In lockForPeople's transaction: invites an email with no account. Whether the invite is new. */
	const putInvite = Effect.fnUntraced(function* (actor: Actor, facts: FactsRow, teamId: string, email: string, role: TeamRole) {
		const [found] = yield* sql<{ role: TeamRole }>`select role from team_invites where team_id = ${teamId} and email = ${email}`;
		if (found?.role === role) return false;
		yield* sql`
			insert into team_invites (team_id, email, role, invited_by) values (${teamId}, ${email}, ${role}, ${actor.id})
			on conflict (team_id, email) do update set role = excluded.role`;
		// The way in, with the default daily credits. An org admin's own invite stays as it is.
		yield* sql`insert into allowed_emails (email, invited_by, team_only) values (${email}, ${actor.id}, true) on conflict (email) do nothing`;
		yield* sql`update teams set updated_at = now() where id = ${teamId}`;
		const team = { team: teamId, name: facts.name };
		yield* events.record({ actor, action: "invite-to-team", target: email, before: found ? { ...team, role: found.role } : null, after: { ...team, role } });
		return !found;
	});

	const invite = Effect.fn("Teams.invite")(function* (actor: Actor, teamId: string, email: string, role: TeamRole) {
		const { name, account, added, invited } = yield* sql.withTransaction(
			Effect.gen(function* () {
				const locked = yield* lockForPeople(actor, teamId);
				const account = yield* accounts.idOfEmail(email);
				const added = Option.isSome(account) ? yield* putMember(actor, locked, teamId, account.value, role) : Option.none<string>();
				const invited = Option.isNone(account) && (yield* putInvite(actor, locked.facts, teamId, email, role));
				return { name: locked.facts.name, account, added, invited };
			}),
		);
		yield* tellAdded(actor, name, role)(added);
		if (invited) yield* emails.invited(email, actor.origin, { team: name, byUserId: actor.id });
		const team = yield* detailNow(actor, teamId);
		return Option.isSome(account) ? { added: true as const, team } : { invited: true as const, team };
	});

	const cancelInvite = Effect.fn("Teams.cancelInvite")(function* (actor: Actor, teamId: string, email: string) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const { facts } = yield* lockForPeople(actor, teamId);
				// Two teams that cancel the same email's invites at once take turns here, so the second sees the first's.
				yield* sql`select 1 from allowed_emails where email = ${email} for update`;
				const [found] = yield* sql<{ role: TeamRole }>`delete from team_invites where team_id = ${teamId} and email = ${email} returning role`;
				if (!found) return;
				// Not an email that an org admin invited, another team still invites, or that has an account and signs in with it.
				yield* sql`
					delete from allowed_emails a where a.email = ${email} and a.team_only
					and not exists (select 1 from team_invites i where i.email = a.email)
					and not exists (select 1 from users u where lower(u.email) = a.email)`;
				yield* sql`update teams set updated_at = now() where id = ${teamId}`;
				yield* events.record({ actor, action: "cancel-team-invite", target: email, before: { team: teamId, name: facts.name, role: found.role } });
			}),
		);
		return yield* detailNow(actor, teamId);
	});

	return Teams.of({ migrate, adminScope, list, search, create, update, get, setMember, removeMember, invite, cancelInvite });
});

export const layer = Layer.effect(Teams, make);
