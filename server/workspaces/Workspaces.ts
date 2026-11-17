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
import { type Access, accessFrom, atLeast, canManage, type Kind, type MemberAccess } from "./access.ts";
import { documentStore, type DocumentSummary } from "./documents/store.ts";
import { migrateDocuments } from "./documents/tables.ts";
import { type DetailRow, type Rows, rowsOf, type SummaryRow } from "./rows.ts";

/**
 * Workspaces (docs/workspaces-plan.md): a name, a description, instructions and documents
 * that a person keeps for their chats, for themselves, for people they add, or for
 * everyone. The documents' upload and indexing are in documents/.
 *
 * Every read and write goes through the access of the person who asks (access.ts). A
 * workspace that the person cannot use, or that was deleted, is WorkspaceNotFound, so an
 * answer never shows that it exists. Changes to organisation workspaces go to the admin
 * activity log (AdminEvents.ts).
 *
 * A chat stays its writer's own: nothing here reads or lists chats. A chat only points to
 * its workspace (`threads.workspace_id`), and a deleted workspace lets its chats go.
 */
export type { Access, Kind, MemberAccess } from "./access.ts";

/** Who asks for a change: their id, and their email for the activity log. */
export type Actor = { id: string; email: string };
export type Person = { id: string; name: string; email: string };
export type Member = Person & { access: MemberAccess };

/** A row of the sidebar (GET /api/workspaces, the boot page). `memberCount` is 0 for an organisation workspace: everyone uses it. */
export type WorkspaceSummary = {
	id: string;
	kind: Kind;
	name: string;
	description: string;
	icon: string | null;
	/** Never none in the list. A detail can say none: after sharing, the person who changed it may no longer use it. */
	access: Access;
	memberCount: number;
	updatedAt: string;
};

/** One workspace (GET /api/workspaces/:id). `members` only for a person who can change them (`canShare`), else null. */
export type WorkspaceDetail = WorkspaceSummary & {
	instructions: string;
	owner: Person;
	canShare: boolean;
	createdAt: string;
	members: Member[] | null;
	/** Oldest first, with their status, for everyone who can ask. */
	documents: DocumentSummary[];
};

export type NewWorkspace = { kind: Kind; name: string; description: string; instructions: string; icon: string | null };
export type WorkspaceChanges = Partial<Omit<NewWorkspace, "kind">>;
export type Sharing = { kind: Kind; members: ReadonlyArray<{ userId: string; access: MemberAccess }> };

/** No such workspace, or not one the person can use. Routes answer 404. */
export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()("WorkspaceNotFound", {
	workspaceId: Schema.String,
}) {
	override get message() {
		return "This workspace was not found.";
	}
}

const REFUSALS = {
	"org-needs-admin": "Only an admin can make a workspace for everyone.",
	"needs-edit": "You can ask in this workspace, but not change it.",
	"needs-manage": "Only the owner can share or delete this workspace. For a workspace for everyone, only an admin can.",
} as const;

/** The person can use the workspace, but not for this. Routes answer 403 with the message. */
export class WorkspaceRefused extends Schema.TaggedError<WorkspaceRefused>()("WorkspaceRefused", {
	reason: Schema.Literals(["org-needs-admin", "needs-edit", "needs-manage"]),
}) {
	override get message() {
		return REFUSALS[this.reason];
	}
}

/** A member to add has no account. */
export class UnknownPeople extends Schema.TaggedError<UnknownPeople>()("UnknownPeople", {
	count: Schema.Number,
}) {
	override get message() {
		return "Someone in the list has no account.";
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
		/** The workspaces the person can use: organisation ones first, then those shared with them, then their own; by name. */
		readonly list: (userId: string) => Effect.Effect<WorkspaceSummary[], SqlError>;
		readonly get: (userId: string, workspaceId: string) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | SqlError>;
		/** Anyone makes a private workspace; only an admin an organisation one. The maker is its owner. */
		readonly create: (actor: Actor, input: NewWorkspace) => Effect.Effect<WorkspaceDetail, WorkspaceRefused | SqlError>;
		/** Name, description, instructions and icon: `edit` and above. */
		readonly update: (actor: Actor, workspaceId: string, changes: WorkspaceChanges) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** Kind and members, in place of the ones before. An organisation workspace keeps no members. */
		readonly share: (actor: Actor, workspaceId: string, sharing: Sharing) => Effect.Effect<WorkspaceDetail, WorkspaceNotFound | WorkspaceRefused | UnknownPeople | SqlError>;
		/** Marks it deleted, deletes its documents, and lets its chats go: they stay their writers', in no workspace. */
		readonly remove: (actor: Actor, workspaceId: string) => Effect.Effect<void, WorkspaceNotFound | WorkspaceRefused | SqlError>;
		/** The name and instructions for a chat turn (workflow/steps.ts), when the person can still ask in it. */
		readonly instructionsFor: (userId: string, workspaceId: string) => Effect.Effect<Option.Option<{ name: string; instructions: string }>, SqlError>;
	}
>()("ponder/workspaces/Workspaces") {}

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
				kind text not null check (kind in ('org', 'private')),
				owner_id text not null references users (id),
				name text not null,
				description text not null default '',
				instructions text not null default '',
				icon text,
				created_at timestamptz not null default now(),
				updated_at timestamptz not null default now(),
				deleted_at timestamptz
			)`;
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
		// Threads.migrate adds the column, since the chat list reads it; the key needs this table.
		yield* sql.unsafe(`
			do $$ begin
				if not exists (select 1 from pg_constraint where conname = 'threads_workspace_id_fkey' and conrelid = 'threads'::regclass) then
					alter table threads add constraint threads_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete set null;
				end if;
			end $$`);
		yield* migrateDocuments(sql);
	});

	/** The person's access, and whether they are an admin; none for a deleted or unknown workspace. */
	const resolve = Effect.fnUntraced(function* (userId: string, workspaceId: string) {
		const found = yield* rows.facts({ userId, workspaceId });
		if (Option.isNone(found)) return { access: "none" as Access, admin: false, kind: "private" as Kind };
		const admin = roleFrom(found.value.role) === "admin";
		const facts = { kind: found.value.kind, ownerId: found.value.owner_id, member: found.value.member };
		return { access: accessFrom(facts, userId, admin), admin, kind: found.value.kind };
	});

	/** The workspace for a person who can use it at `needed` or above; not found when they can't use it at all. */
	const withAccess = Effect.fnUntraced(function* (userId: string, workspaceId: string, needed: "ask" | "edit" | "manage") {
		const found = yield* resolve(userId, workspaceId);
		if (found.access === "none") return yield* new WorkspaceNotFound({ workspaceId });
		if (needed === "edit" && !atLeast(found.access, "edit")) return yield* new WorkspaceRefused({ reason: "needs-edit" });
		if (needed === "manage" && !canManage(found.kind, found.access, found.admin)) return yield* new WorkspaceRefused({ reason: "needs-manage" });
		return found;
	});

	/** The detail as this person sees it. */
	const detail = Effect.fnUntraced(function* (workspaceId: string, access: Access, admin: boolean) {
		const row = Option.getOrThrow(yield* rows.detail(workspaceId));
		const canShare = canManage(row.kind, access, admin);
		const members = canShare ? yield* rows.members(workspaceId) : null;
		return detailFrom(row, access, canShare, members, yield* documents.list(workspaceId));
	});

	/** Organisation workspaces are org-wide content, so their changes go to the activity log. */
	const audit = (actor: Actor, action: string, kinds: Kind[], before: Record<string, unknown> | null, after: Record<string, unknown> | null) =>
		kinds.includes("org") ? events.record({ actor, action, before, after }) : Effect.void;

	const accessOf = Effect.fn("Workspaces.accessOf")(function* (userId: string, workspaceId: string) {
		return (yield* resolve(userId, workspaceId)).access;
	});

	const check = Effect.fn("Workspaces.check")(function* (userId: string, workspaceId: string, needed: "ask" | "edit") {
		yield* withAccess(userId, workspaceId, needed);
	});

	const list = Effect.fn("Workspaces.list")(function* (userId: string) {
		const admin = yield* accounts.isAdmin(userId);
		const found = yield* rows.summaries(userId);
		return found.map((row) => summaryFrom(row, accessFrom({ kind: row.kind, ownerId: row.owner_id, member: row.member }, userId, admin))).sort(sidebarOrder);
	});

	const get = Effect.fn("Workspaces.get")(function* (userId: string, workspaceId: string) {
		const found = yield* resolve(userId, workspaceId);
		if (found.access === "none") return yield* new WorkspaceNotFound({ workspaceId });
		return yield* detail(workspaceId, found.access, found.admin);
	});

	const create = Effect.fn("Workspaces.create")(function* (actor: Actor, input: NewWorkspace) {
		const admin = yield* accounts.isAdmin(actor.id);
		if (input.kind === "org" && !admin) return yield* new WorkspaceRefused({ reason: "org-needs-admin" });
		const id = randomUUID();
		yield* sql`
			insert into workspaces (id, kind, owner_id, name, description, instructions, icon)
			values (${id}, ${input.kind}, ${actor.id}, ${input.name}, ${input.description}, ${input.instructions}, ${input.icon})`;
		const created = yield* detail(id, "owner", admin);
		yield* audit(actor, "create-workspace", [created.kind], null, auditView(created));
		return created;
	});

	const update = Effect.fn("Workspaces.update")(function* (actor: Actor, workspaceId: string, changes: WorkspaceChanges) {
		const found = yield* withAccess(actor.id, workspaceId, "edit");
		const changed = yield* setFields(workspaceId, changes);
		// Deleted since the access check.
		if (Option.isNone(changed)) return yield* new WorkspaceNotFound({ workspaceId });
		const { before, after } = changed.value;
		yield* audit(actor, "update-workspace", [before.kind, after.kind], before, after);
		return yield* detail(workspaceId, found.access, found.admin);
	});

	/**
	 * Sets only the fields given, in one statement, so that a change to another field made
	 * at the same time stays. The row as this statement found and left it, for the log:
	 * the subquery locks the row and reads its latest version.
	 */
	const setFields = Effect.fnUntraced(function* (workspaceId: string, changes: WorkspaceChanges) {
		const fields = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
		const assignments = Object.keys(fields).length > 0 ? sql`${sql.update(fields)}, updated_at = now()` : sql`updated_at = now()`;
		const found = yield* sql<{ before: AuditView; after: AuditView }>`
			update workspaces w set ${assignments}
			from (select * from workspaces where id = ${workspaceId} and deleted_at is null for update) old
			where w.id = old.id
			returning ${auditJson("old")} as before, ${auditJson("w")} as after`;
		return Arr.head(found);
	});

	/** auditView's fields, from a row of `workspaces` under this alias. */
	const auditJson = (alias: "old" | "w") =>
		sql.literal(`jsonb_build_object('workspace', ${alias}.id, 'kind', ${alias}.kind, 'name', ${alias}.name, 'description', ${alias}.description, 'instructions', ${alias}.instructions, 'icon', ${alias}.icon)`);

	const share = Effect.fn("Workspaces.share")(function* (actor: Actor, workspaceId: string, sharing: Sharing) {
		const found = yield* withAccess(actor.id, workspaceId, "manage");
		// Making a workspace for everyone, or taking it back, is an admin's: the same rule as making one.
		if (sharing.kind !== found.kind && !found.admin) return yield* new WorkspaceRefused({ reason: "org-needs-admin" });
		const ownerId = Option.getOrThrow(yield* rows.detail(workspaceId)).owner_id;
		const members = sharing.kind === "org" ? [] : membersToKeep(sharing.members, ownerId);
		const known = yield* rows.existing(members.map((member) => member.userId));
		if (known.length < members.length) return yield* new UnknownPeople({ count: members.length - known.length });
		const before = { workspace: workspaceId, kind: found.kind, members: memberIds(yield* rows.members(workspaceId)) };
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`update workspaces set kind = ${sharing.kind}, updated_at = now() where id = ${workspaceId}`;
				const ids = members.map((member) => member.userId);
				yield* sql`delete from workspace_members where workspace_id = ${workspaceId} and not (user_id = any(${ids}))`;
				const added = members.map((member) => ({ workspace_id: workspaceId, user_id: member.userId, access: member.access, added_by: actor.id }));
				if (!Arr.isArrayNonEmpty(added)) return;
				// A member who stays keeps when and by whom they were added.
				yield* sql`insert into workspace_members ${sql.insert(added)} on conflict (workspace_id, user_id) do update set access = excluded.access`;
			}),
		);
		// Read again: an admin who makes an organisation workspace private, and is not its owner, may no longer use it.
		const after = yield* detail(workspaceId, yield* accessOf(actor.id, workspaceId), found.admin);
		yield* audit(actor, "share-workspace", [found.kind, after.kind], before, { workspace: workspaceId, kind: after.kind, members: memberIds(yield* rows.members(workspaceId)) });
		return after;
	});

	const remove = Effect.fn("Workspaces.remove")(function* (actor: Actor, workspaceId: string) {
		const found = yield* withAccess(actor.id, workspaceId, "manage");
		const before = yield* detail(workspaceId, found.access, found.admin);
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`update workspaces set deleted_at = now(), updated_at = now() where id = ${workspaceId}`;
				yield* sql`delete from workspace_members where workspace_id = ${workspaceId}`;
				// The chats stay their writers', in no workspace.
				yield* sql`update threads set workspace_id = null where workspace_id = ${workspaceId}`;
				// With their passages and logs; the bytes in the bucket after them.
				yield* documents.removeAll(workspaceId);
			}),
		);
		yield* audit(actor, "delete-workspace", [before.kind], auditView(before), null);
	});

	const instructionsFor = Effect.fn("Workspaces.instructionsFor")(function* (userId: string, workspaceId: string) {
		const found = yield* resolve(userId, workspaceId);
		if (!atLeast(found.access, "ask")) return Option.none();
		return Option.map(yield* rows.detail(workspaceId), (row) => ({ name: row.name, instructions: row.instructions }));
	});

	return Workspaces.of({ migrate, accessOf, check, list, get, create, update, share, remove, instructionsFor });
});

export const layer = Layer.effect(Workspaces, make);

function summaryFrom(row: SummaryRow, access: Access): WorkspaceSummary {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		description: row.description,
		icon: row.icon,
		access,
		memberCount: row.kind === "org" ? 0 : row.member_count,
		updatedAt: row.updated_at.toISOString(),
	};
}

function detailFrom(row: DetailRow, access: Access, canShare: boolean, members: Member[] | null, documents: DocumentSummary[]): WorkspaceDetail {
	return {
		...summaryFrom(row, access),
		instructions: row.instructions,
		owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
		canShare,
		createdAt: row.created_at.toISOString(),
		members,
		documents,
	};
}

/** Organisation first, then shared with the person, then their own; by name within each. */
function sidebarOrder(a: WorkspaceSummary, b: WorkspaceSummary) {
	return group(a) - group(b) || a.name.localeCompare(b.name);
}

function group(workspace: WorkspaceSummary) {
	if (workspace.kind === "org") return 0;
	return workspace.access === "owner" ? 2 : 1;
}

/** One row for each person, the last one given winning; never the owner, who is no member. */
function membersToKeep(members: Sharing["members"], ownerId: string) {
	const byId = new Map(members.filter((member) => member.userId !== ownerId).map((member) => [member.userId, member]));
	return [...byId.values()];
}

/** What the activity log keeps of a workspace. */
type AuditView = ReturnType<typeof auditView>;

function auditView(workspace: WorkspaceDetail) {
	const { id, kind, name, description, instructions, icon } = workspace;
	return { workspace: id, kind, name, description, instructions, icon };
}

function memberIds(members: Member[]) {
	return members.map(({ id, access }) => ({ id, access }));
}
