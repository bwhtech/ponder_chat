import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as AdminEvents from "../admin/AdminEvents.ts";
import * as ObjectStore from "../files/ObjectStore.ts";
import * as Accounts from "../people/Accounts.ts";
import { roleFrom } from "../people/Accounts.ts";
import { TeamNotFound } from "../teams/Teams.ts";
import { type Access, accessFrom, atLeast, canChangeOrgAccess, canDelete, canShare, type MemberAccess, type OrgAccess } from "./access.ts";
import { documentStore, type DocumentSummary } from "./documents/store.ts";
import { migrateDocuments } from "./documents/tables.ts";
import { type DetailRow, type Rows, rowsOf, type SummaryRow } from "./rows.ts";
import { claimSlug, migrateSlugs } from "./slug.ts";

/**
 * Workspaces (docs/workspaces-plan.md): a name, a description, instructions and documents
 * that a person keeps for their chats, for themselves, for people they add, or for
 * everyone. The documents' upload and indexing are in documents/.
 *
 * Every read and write goes through the access of the person who asks (access.ts). A
 * workspace that the person cannot use, or that was deleted, is WorkspaceNotFound, so an
 * answer never shows that it exists. Changes to a workspace while it is open to everyone go
 * to the admin activity log (AdminEvents.ts).
 *
 * Sharing is one change at a time: a person or a team added or given a role, a person or
 * a team removed, or General access opened or closed. Two people who change different
 * people at once both keep their change. A team grant is live: who is in the team now
 * has its access (docs/teams-plan.md).
 *
 * A chat stays its writer's own: nothing here reads or lists chats. A chat only points to
 * its workspace (`threads.workspace_id`), and a deleted workspace lets its chats go.
 */
export type { Access, MemberAccess, OrgAccess } from "./access.ts";

/** Who asks for a change: their id, and their email for the activity log. */
export type Actor = { id: string; email: string };
export type Person = { id: string; name: string; email: string };
export type Member = Person & { access: MemberAccess };
/** A team added to a workspace. An archived team keeps its grant, but gives no access. */
export type WorkspaceTeam = { id: string; name: string; memberCount: number; access: MemberAccess; archived: boolean };

/**
 * A row of the sidebar (GET /api/workspaces, the boot page). `pinned` is the person's own:
 * nobody else sees it.
 */
export type WorkspaceSummary = {
	id: string;
	/** Its address on the page (slug.ts): made from the first name, and kept on a rename. */
	slug: string;
	/** General access: "ask" when everyone in the organisation can ask in it. */
	orgAccess: OrgAccess;
	name: string;
	description: string;
	icon: string | null;
	/** Never none in the list. A detail can say none: after sharing, the person who changed it may no longer use it. */
	access: Access;
	/** The people added, without the owner. */
	memberCount: number;
	/** The active teams added. */
	teamCount: number;
	pinned: boolean;
	/** To the microsecond, in UTC ISO 8601: the list's order. */
	createdAt: string;
	updatedAt: string;
};

/**
 * One workspace (GET /api/workspaces/:id), as the person who asks may use it. `members` and
 * `teams` only for a person who can change them (`canShare`), else null.
 */
export type WorkspaceDetail = Omit<WorkspaceSummary, "pinned"> & {
	instructions: string;
	owner: Person;
	canShare: boolean;
	canDelete: boolean;
	/** Opens it to everyone, or closes it: admins only (access.ts). */
	canChangeOrgAccess: boolean;
	members: Member[] | null;
	/** By name, archived teams too. */
	teams: WorkspaceTeam[] | null;
	/** Oldest first, with their status, for everyone who can ask. */
	documents: DocumentSummary[];
};

/** Every workspace starts private: an admin opens it to everyone from Share. */
export type NewWorkspace = { name: string; description: string; instructions: string; icon: string | null };
export type WorkspaceChanges = Partial<NewWorkspace>;

/** No such workspace, or not one the person can use. Routes answer 404. */
export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()("WorkspaceNotFound", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace was not found.";
	}
}

const REFUSALS = {
	"org-needs-admin": "Only an admin can open a workspace to everyone, or close it.",
	"org-needs-owner": "Only its owner can open this workspace to everyone.",
	"needs-edit": "You can ask in this workspace, but not change it.",
	"needs-share": "Only the owner and people who can edit can share this workspace.",
	"needs-delete": "Only the owner can delete this workspace. While it is open to everyone, admins can too.",
	"owner-fixed": "The owner always has full access.",
	"team-archived": "This team is archived, so it can't be added.",
} as const;

/** The person can use the workspace, but not for this. Routes answer 403 with the message. */
export class WorkspaceRefused extends Schema.TaggedError<WorkspaceRefused>()("WorkspaceRefused", {
	reason: Schema.Literals(["org-needs-admin", "org-needs-owner", "needs-edit", "needs-share", "needs-delete", "owner-fixed", "team-archived"]),
}) {
	override get message() {
		return REFUSALS[this.reason];
	}
}

/** The person to add has no account. */
export class UnknownPerson extends Schema.TaggedError<UnknownPerson>()("UnknownPerson", {
	userId: Schema.String,
}) {
	override get message() {
		return "That person has no account.";
	}
}

export class Workspaces extends Context.Service<
	Workspaces,
	{
		/** The tables, and the foreign key of `threads.workspace_id`. After Auth (users) and Threads. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The person's access, by the table in access.ts. A deleted workspace, or one that does not exist, is none. */
		readonly accessOf: (userId: string, workspaceId: string) => Effect.Effect<Access, SqlError>;
		/** Succeeds when the person can use the workspace at `needed` or above: not found when they can't use it at all. */
		readonly check: (userId: string, workspaceId: string, needed: "ask" | "edit") => Effect.Effect<void, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/**
		 * `check`, inside the caller's transaction, with the workspace's row locked until it
		 * ends: a delete waits for it, and it waits for a delete. The caller then inserts what
		 * belongs to the workspace (a chat, a document) in the same transaction, so nothing is
		 * added to a workspace that a delete has let go. Keep the transaction short.
		 */
		readonly admit: (userId: string, workspaceId: string, needed: "ask" | "edit") => Effect.Effect<void, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** The workspaces the person can use: the ones they pinned first, then the newest made first. */
		readonly list: (userId: string) => Effect.Effect<WorkspaceSummary[], SqlError>;
		/** Pins a workspace at the top of the person's own list, or unpins it: any access will do. Nobody else sees it. */
		readonly pin: (userId: string, workspaceId: string, pinned: boolean) => Effect.Effect<void, WorkspaceNotFound | SqlError>;
		/** By its id or its slug: the page's address has the slug, and older links the id. */
		readonly get: (userId: string, idOrSlug: string) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | SqlError>;
		/** Anyone makes a workspace, private. The maker is its owner. */
		readonly create: (actor: Actor, input: NewWorkspace) => Effect.Effect<WorkspaceDetail, SqlError>;
		/** Name, description, instructions and icon: `edit` and above. */
		readonly update: (actor: Actor, workspaceId: string, changes: WorkspaceChanges) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** Adds a person with this role, or gives a member this role: whoever can share (access.ts). Never the owner. */
		readonly setMember: (
			actor: Actor,
			workspaceId: string,
			userId: string,
			access: MemberAccess,
		) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | UnknownPerson | SqlError>;
		/** Removes a person: whoever can share, themselves too. Never the owner. Removing someone who is no member changes nothing. */
		readonly removeMember: (actor: Actor, workspaceId: string, userId: string) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/**
		 * Adds an active team with this role, or gives a team this role: whoever can share. An
		 * archived team can't be added, but its role can still be changed.
		 */
		readonly setTeam: (
			actor: Actor,
			workspaceId: string,
			teamId: string,
			access: MemberAccess,
		) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | TeamNotFound | SqlError>;
		/** Removes a team, archived ones too: whoever can share. Removing a team that was not added changes nothing. */
		readonly removeTeam: (actor: Actor, workspaceId: string, teamId: string) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** Opens it to everyone in the organisation, or closes it: admins only. Its people keep their roles either way. */
		readonly setOrgAccess: (actor: Actor, workspaceId: string, orgAccess: OrgAccess) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** Marks it deleted, deletes its documents, and lets its chats go: they stay their writers', in no workspace. */
		readonly remove: (actor: Actor, workspaceId: string) => Effect.Effect<void, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** The name and instructions for a chat turn (workflow/steps.ts), when the person can still ask in it. */
		readonly instructionsFor: (userId: string, workspaceId: string) => Effect.Effect<Option.Option<{ name: string; instructions: string }>, SqlError>;
	}
>()("ponder/workspaces/Workspaces") {}

/** What a person's access was decided from, for the checks after it. */
type Resolved = { access: Access; admin: boolean; orgAccess: OrgAccess; ownerId: string };

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const accounts = yield* Accounts.Accounts;
	const events = yield* AdminEvents.AdminEvents;
	const rows: Rows = rowsOf(sql);
	const documents = documentStore(sql, yield* ObjectStore.ObjectStore);

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists workspaces (
				id text primary key,
				org_access text not null default 'none' check (org_access in ('none', 'ask')),
				owner_id text not null references users (id),
				name text not null,
				description text not null default '',
				instructions text not null default '',
				icon text,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now(),
				deleted_at timestamptz
			)`;
		yield* migrateOrgAccess;
		yield* migrateSlugs(sql);
		yield* sql`
			create table if not exists workspace_members (
				workspace_id text not null references workspaces (id) on delete cascade,
				user_id text not null references users (id) on delete cascade,
				access text not null check (access in ('ask', 'edit')),
				added_by text not null,
				added_at timestamptz not null default now(),
				primary key (workspace_id, user_id)
			)`;
		yield* sql`create index if not exists workspace_members_user on workspace_members (user_id)`;
		// The list's order (rows.ts): the newest made first, of the workspaces not deleted.
		yield* sql`create index if not exists workspaces_created on workspaces (created_at desc, id desc) where deleted_at is null`;
		// A person's pins: only theirs, and only the list reads them, by person.
		yield* sql`
			create table if not exists workspace_pins (
				user_id text not null references users (id) on delete cascade,
				workspace_id text not null references workspaces (id) on delete cascade,
				pinned_at timestamptz not null default now(),
				primary key (user_id, workspace_id)
			)`;
		yield* sql`create index if not exists workspace_pins_workspace on workspace_pins (workspace_id)`;
		// Threads.migrate adds the column, since the chat list reads it; the key needs this table.
		yield* sql.unsafe(`
			do $$ begin
				if not exists (select 1 from pg_constraint where conname = 'threads_workspace_id_fkey' and conrelid = 'threads'::regclass) then
					alter table threads add constraint threads_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete set null;
				end if;
			end $$`);
		yield* migrateDocuments(sql);
	});

	/**
	 * Workspaces made before General access had a `kind`: an organisation workspace ('org',
	 * which kept no members) is open to everyone; a private one keeps its people. Once
	 * `kind` is gone, this changes nothing. Two servers that start at once take turns: the
	 * advisory lock is held until the transaction ends, and is taken before `kind` is looked
	 * for, so the second one finds it gone.
	 */
	const migrateOrgAccess = sql.withTransaction(
		Effect.gen(function* () {
			yield* sql`select pg_advisory_xact_lock(hashtext('ponder.workspaces.org_access'))`;
			yield* sql`alter table workspaces add column if not exists org_access text not null default 'none' check (org_access in ('none', 'ask'))`;
			yield* sql.unsafe(`
				do $$ begin
					if exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'workspaces' and column_name = 'kind') then
						update workspaces set org_access = 'ask' where kind = 'org';
						alter table workspaces drop column kind;
					end if;
				end $$`);
		}),
	);

	/** The person's access, and whether they are an admin; none for a deleted or unknown workspace. */
	const resolve = Effect.fnUntraced(function* (userId: string, workspaceId: string) {
		const found = yield* rows.facts({ userId, workspaceId });
		const resolved: Resolved = { access: "none", admin: false, orgAccess: "none", ownerId: "" };
		if (Option.isNone(found)) return resolved;
		resolved.admin = roleFrom(found.value.role) === "admin";
		resolved.orgAccess = found.value.org_access;
		resolved.ownerId = found.value.owner_id;
		resolved.access = accessFrom({ orgAccess: resolved.orgAccess, ownerId: resolved.ownerId, member: found.value.member, team: found.value.team }, userId, resolved.admin);
		return resolved;
	});

	/** The workspace for a person who can use it for `needed`; not found when they can't use it at all. */
	const withAccess = Effect.fnUntraced(function* (userId: string, workspaceId: string, needed: "ask" | "edit" | "share" | "delete") {
		const found = yield* resolve(userId, workspaceId);
		if (found.access === "none") return yield* new WorkspaceNotFound({ workspaceId });
		if (needed === "edit" && !atLeast(found.access, "edit")) return yield* new WorkspaceRefused({ reason: "needs-edit" });
		if (needed === "share" && !canShare(found.access)) return yield* new WorkspaceRefused({ reason: "needs-share" });
		if (needed === "delete" && !canDelete(found.orgAccess, found.access, found.admin)) return yield* new WorkspaceRefused({ reason: "needs-delete" });
		return found;
	});

	/** The detail as this person sees it. */
	const detail = Effect.fnUntraced(function* (workspaceId: string, access: Access, admin: boolean) {
		const row = Option.getOrThrow(yield* rows.detail(workspaceId));
		const rights = {
			canShare: canShare(access),
			canDelete: canDelete(row.org_access, access, admin),
			canChangeOrgAccess: canChangeOrgAccess(row.org_access, access, admin),
		};
		const people = rights.canShare ? { members: yield* rows.members(workspaceId), teams: yield* rows.teams(workspaceId) } : { members: null, teams: null };
		return detailFrom(row, access, rights, people, yield* documents.list(workspaceId));
	});

	/** A workspace open to everyone is organisation content, so its changes go to the activity log: open before or after. */
	const audit = (actor: Actor, action: string, open: boolean, before: Record<string, unknown> | null, after: Record<string, unknown> | null) =>
		open ? events.record({ actor, action, before, after }) : Effect.void;

	const accessOf = Effect.fn("Workspaces.accessOf")(function* (userId: string, workspaceId: string) {
		return (yield* resolve(userId, workspaceId)).access;
	});

	const check = Effect.fn("Workspaces.check")(function* (userId: string, workspaceId: string, needed: "ask" | "edit") {
		yield* withAccess(userId, workspaceId, needed);
	});

	/**
	 * Every change to a workspace locks its row first, inside the caller's transaction, and only
	 * then reads the person's access: a change made meanwhile (a person removed, General access
	 * closed, the workspace deleted) is in before the check, never after it.
	 *
	 * - `add`, FOR SHARE: what is added to the workspace, or the person's own state in it (a
	 *   chat, a document, a pin). These do not wait for each other.
	 * - `change`, FOR NO KEY UPDATE: the workspace itself (its fields, its people, General
	 *   access). These take turns, and wait for the adds in progress, which wait for them.
	 * - `delete`, FOR UPDATE: waits for all of these, and they then find it deleted.
	 *
	 * Read committed: a statement that waited reads the row again, as the other left it.
	 */
	const LOCKS = { add: "for share", change: "for no key update", delete: "for update" } as const;
	const lockLive = Effect.fnUntraced(function* (workspaceId: string, lock: keyof typeof LOCKS) {
		const live = yield* sql`select id from workspaces where id = ${workspaceId} and deleted_at is null ${sql.literal(LOCKS[lock])}`;
		if (live.length === 0) return yield* new WorkspaceNotFound({ workspaceId });
	});

	const admit = Effect.fn("Workspaces.admit")(function* (userId: string, workspaceId: string, needed: "ask" | "edit") {
		yield* lockLive(workspaceId, "add");
		yield* withAccess(userId, workspaceId, needed);
	});

	const list = Effect.fn("Workspaces.list")(function* (userId: string) {
		const admin = yield* accounts.isAdmin(userId);
		const found = yield* rows.summaries(userId);
		// In the order the query gives.
		return found.map((row) => ({
			...summaryFrom(row, accessFrom({ orgAccess: row.org_access, ownerId: row.owner_id, member: row.member, team: row.team }, userId, admin)),
			pinned: row.pinned,
		}));
	});

	// Admitted as a chat is (admit): a delete waits for the pin, and then takes it with the workspace;
	// a pin that waited for a delete finds the workspace gone.
	const pin = Effect.fn("Workspaces.pin")(function* (userId: string, workspaceId: string, pinned: boolean) {
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* lockLive(workspaceId, "add");
				if ((yield* resolve(userId, workspaceId)).access === "none") return yield* new WorkspaceNotFound({ workspaceId });
				if (pinned) yield* sql`insert into workspace_pins (user_id, workspace_id) values (${userId}, ${workspaceId}) on conflict (user_id, workspace_id) do nothing`;
				else yield* sql`delete from workspace_pins where user_id = ${userId} and workspace_id = ${workspaceId}`;
			}),
		);
	});

	const get = Effect.fn("Workspaces.get")(function* (userId: string, idOrSlug: string) {
		// An unknown slug and one the person can't use answer the same.
		const workspaceId = Option.getOrElse(yield* rows.idOf(idOrSlug), () => idOrSlug);
		const found = yield* resolve(userId, workspaceId);
		if (found.access === "none") return yield* new WorkspaceNotFound({ workspaceId: idOrSlug });
		return yield* detail(workspaceId, found.access, found.admin);
	});

	// A new workspace is private, so it is not logged: the log has it once it is opened to everyone.
	const create = Effect.fn("Workspaces.create")(function* (actor: Actor, input: NewWorkspace) {
		const admin = yield* accounts.isAdmin(actor.id);
		const id = randomUUID();
		yield* claimSlug(input.name, (slug) =>
			sql`
				insert into workspaces (id, slug, owner_id, name, description, instructions, icon)
				values (${id}, ${slug}, ${actor.id}, ${input.name}, ${input.description}, ${input.instructions}, ${input.icon})
				on conflict (slug) do nothing
				returning id`.pipe(Effect.map((rows) => rows.length > 0)),
		);
		return yield* detail(id, "owner", admin);
	});

	const update = Effect.fn("Workspaces.update")(function* (actor: Actor, workspaceId: string, changes: WorkspaceChanges) {
		const found = yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* lockLive(workspaceId, "change");
				const found = yield* withAccess(actor.id, workspaceId, "edit");
				const { before, after } = Option.getOrThrow(yield* setFields(workspaceId, changes));
				yield* audit(actor, "update-workspace", before.orgAccess !== "none" || after.orgAccess !== "none", before, after);
				return found;
			}),
		);
		return yield* detail(workspaceId, found.access, found.admin);
	});

	/**
	 * Sets only the fields given, in one statement, so that a change to another field made
	 * at the same time stays. The row as this statement found and left it, for the log.
	 */
	const setFields = Effect.fnUntraced(function* (workspaceId: string, changes: WorkspaceChanges) {
		const fields = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
		const assignments = Object.keys(fields).length > 0 ? sql`${sql.update(fields)}, updated_at = now()` : sql`updated_at = now()`;
		const found = yield* sql<{ before: AuditView; after: AuditView }>`
			update workspaces w set ${assignments}
			from (select * from workspaces where id = ${workspaceId} and deleted_at is null for no key update) old
			where w.id = old.id
			returning ${auditJson("old")} as before, ${auditJson("w")} as after`;
		return Arr.head(found);
	});

	/** auditView's fields, from a row of `workspaces` under this alias. */
	const auditJson = (alias: "old" | "w") =>
		sql.literal(
			`jsonb_build_object('workspace', ${alias}.id, 'orgAccess', ${alias}.org_access, 'name', ${alias}.name, 'description', ${alias}.description, 'instructions', ${alias}.instructions, 'icon', ${alias}.icon)`,
		);

	/** Who can use the workspace, for the activity log. */
	const sharingView = Effect.fnUntraced(function* (workspaceId: string) {
		const [found] = yield* sql<{ org_access: OrgAccess }>`select org_access from workspaces where id = ${workspaceId}`;
		const teams = (yield* rows.teams(workspaceId)).map(({ id, name, access }) => ({ id, name, access }));
		return { workspace: workspaceId, orgAccess: found?.org_access ?? "none", members: memberIds(yield* rows.members(workspaceId)), teams };
	});

	/**
	 * One change to who can use the workspace, by a person who can share it, in a transaction
	 * of its own. The workspace's row is locked FOR NO KEY UPDATE: sharing changes to it take
	 * turns, so each one reads the people as the one before left them, and each is logged
	 * with exactly what it changed. A delete waits for it, or it finds the workspace gone
	 * (lockLive). Answers the workspace as the person sees it after the change: they may have
	 * removed themselves.
	 */
	const changeSharing = <E>(actor: Actor, workspaceId: string, change: (found: Resolved) => Effect.Effect<void, E | SqlError>) =>
		Effect.gen(function* () {
			yield* sql.withTransaction(
				Effect.gen(function* () {
					yield* lockLive(workspaceId, "change");
					const found = yield* withAccess(actor.id, workspaceId, "share");
					const before = yield* sharingView(workspaceId);
					yield* change(found);
					const after = yield* sharingView(workspaceId);
					if (JSON.stringify(before) === JSON.stringify(after)) return;
					yield* sql`update workspaces set updated_at = now() where id = ${workspaceId}`;
					yield* audit(actor, "share-workspace", before.orgAccess !== "none" || after.orgAccess !== "none", before, after);
				}),
			);
			const now = yield* resolve(actor.id, workspaceId);
			return yield* detail(workspaceId, now.access, now.admin);
		});

	const setMember = Effect.fn("Workspaces.setMember")(function* (actor: Actor, workspaceId: string, userId: string, access: MemberAccess) {
		return yield* changeSharing(actor, workspaceId, (found) =>
			Effect.gen(function* () {
				if (userId === found.ownerId) return yield* new WorkspaceRefused({ reason: "owner-fixed" });
				if ((yield* rows.existing([userId])).length === 0) return yield* new UnknownPerson({ userId });
				// A member who stays keeps when and by whom they were added.
				yield* sql`
					insert into workspace_members (workspace_id, user_id, access, added_by) values (${workspaceId}, ${userId}, ${access}, ${actor.id})
					on conflict (workspace_id, user_id) do update set access = excluded.access`;
			}),
		);
	});

	const removeMember = Effect.fn("Workspaces.removeMember")(function* (actor: Actor, workspaceId: string, userId: string) {
		return yield* changeSharing(actor, workspaceId, (found) =>
			Effect.gen(function* () {
				if (userId === found.ownerId) return yield* new WorkspaceRefused({ reason: "owner-fixed" });
				yield* sql`delete from workspace_members where workspace_id = ${workspaceId} and user_id = ${userId}`;
			}),
		);
	});

	const setTeam = Effect.fn("Workspaces.setTeam")(function* (actor: Actor, workspaceId: string, teamId: string, access: MemberAccess) {
		return yield* changeSharing(actor, workspaceId, () =>
			Effect.gen(function* () {
				// The team's row, shared until the end: an archive waits for the grant, or the grant sees it archived.
				const [team] = yield* sql<{ archived: boolean }>`select archived_at is not null as archived from teams where id = ${teamId} for share`;
				if (!team) return yield* new TeamNotFound({ teamId });
				if (team.archived) {
					const changed = yield* sql`update workspace_teams set access = ${access} where workspace_id = ${workspaceId} and team_id = ${teamId} returning team_id`;
					if (changed.length === 0) return yield* new WorkspaceRefused({ reason: "team-archived" });
					return;
				}
				// A team that stays keeps when and by whom it was added.
				yield* sql`
					insert into workspace_teams (workspace_id, team_id, access, added_by) values (${workspaceId}, ${teamId}, ${access}, ${actor.id})
					on conflict (workspace_id, team_id) do update set access = excluded.access`;
			}),
		);
	});

	const removeTeam = Effect.fn("Workspaces.removeTeam")(function* (actor: Actor, workspaceId: string, teamId: string) {
		return yield* changeSharing(actor, workspaceId, () => Effect.asVoid(sql`delete from workspace_teams where workspace_id = ${workspaceId} and team_id = ${teamId}`));
	});

	const setOrgAccess = Effect.fn("Workspaces.setOrgAccess")(function* (actor: Actor, workspaceId: string, orgAccess: OrgAccess) {
		return yield* changeSharing(actor, workspaceId, (found) =>
			Effect.gen(function* () {
				if (orgAccess === found.orgAccess) return;
				if (!found.admin) return yield* new WorkspaceRefused({ reason: "org-needs-admin" });
				if (!canChangeOrgAccess(found.orgAccess, found.access, found.admin)) return yield* new WorkspaceRefused({ reason: "org-needs-owner" });
				yield* sql`update workspaces set org_access = ${orgAccess} where id = ${workspaceId}`;
			}),
		);
	});

	const remove = Effect.fn("Workspaces.remove")(function* (actor: Actor, workspaceId: string) {
		const { keys, before } = yield* sql.withTransaction(
			Effect.gen(function* () {
				// Waits for the chats and documents being added now (admit), and they wait for this.
				yield* lockLive(workspaceId, "delete");
				const found = yield* withAccess(actor.id, workspaceId, "delete");
				const before = yield* detail(workspaceId, found.access, found.admin);
				yield* sql`update workspaces set deleted_at = now(), updated_at = now() where id = ${workspaceId}`;
				yield* sql`delete from workspace_members where workspace_id = ${workspaceId}`;
				yield* sql`delete from workspace_teams where workspace_id = ${workspaceId}`;
				yield* sql`delete from workspace_pins where workspace_id = ${workspaceId}`;
				// The chats stay their writers', in no workspace.
				yield* sql`update threads set workspace_id = null where workspace_id = ${workspaceId}`;
				// With their passages and logs.
				return { keys: yield* documents.removeAll(workspaceId), before };
			}),
		);
		// The bytes in the bucket only once the rows are gone for good: no bucket call holds the transaction open.
		yield* documents.removeObjects(keys);
		yield* audit(actor, "delete-workspace", before.orgAccess !== "none", auditView(before), null);
	});

	const instructionsFor = Effect.fn("Workspaces.instructionsFor")(function* (userId: string, workspaceId: string) {
		const found = yield* resolve(userId, workspaceId);
		if (!atLeast(found.access, "ask")) return Option.none();
		return Option.map(yield* rows.detail(workspaceId), (row) => ({ name: row.name, instructions: row.instructions }));
	});

	return Workspaces.of({ migrate, accessOf, check, admit, list, pin, get, create, update, setMember, removeMember, setTeam, removeTeam, setOrgAccess, remove, instructionsFor });
});

export const layer = Layer.effect(Workspaces, make);

function summaryFrom(row: SummaryRow, access: Access): Omit<WorkspaceSummary, "pinned"> {
	return {
		id: row.id,
		slug: row.slug,
		orgAccess: row.org_access,
		name: row.name,
		description: row.description,
		icon: row.icon,
		access,
		memberCount: row.member_count,
		teamCount: row.team_count,
		createdAt: row.created_at,
		updatedAt: row.updated_at.toISOString(),
	};
}

type Rights = Pick<WorkspaceDetail, "canShare" | "canDelete" | "canChangeOrgAccess">;

function detailFrom(row: DetailRow, access: Access, rights: Rights, people: Pick<WorkspaceDetail, "members" | "teams">, documents: DocumentSummary[]): WorkspaceDetail {
	return {
		...summaryFrom(row, access),
		instructions: row.instructions,
		owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
		...rights,
		...people,
		documents,
	};
}

/** What the activity log keeps of a workspace. */
type AuditView = ReturnType<typeof auditView>;

function auditView(workspace: WorkspaceDetail) {
	const { id, orgAccess, name, description, instructions, icon } = workspace;
	return { workspace: id, orgAccess, name, description, instructions, icon };
}

function memberIds(members: Member[]) {
	return members.map(({ id, access }) => ({ id, access }));
}
