import { isAPIError } from "better-auth/api";
import { recordAdminEvent } from "./admin-events.ts";
import { sql } from "./db.ts";
import { emailChangedEmail, sendEmail } from "./email.ts";

/**
 * Better Auth's admin endpoints in the admin activity log (admin-events.ts). The browser
 * can call them at /api/auth/admin/*, and /admin calls them through auth.api (viaAuth in
 * admin/routes.ts), so auth.ts logs them here, in its hooks, and admin/routes.ts does not.
 * Every admin endpoint that changes something is logged, and only when it succeeds.
 *
 * The after hook sees only the result, so the before hook reads the person's row first.
 * Both hooks of one call get the same `ctx.context` object (Better Auth puts the admin's
 * session on it in between), so the row waits there, in a WeakMap.
 *
 * When an admin changes someone's email, the old address gets a notice: that address no
 * longer signs in to the account, so its owner must hear about it.
 */
type HookContext = {
	path?: string;
	body?: Record<string, unknown> | null;
	context: { returned?: unknown; session?: { user: { id: string; email: string; name?: string | null } } | null };
};

/** Admin endpoints that only read. Every other /admin/* endpoint is logged. */
const READ_ONLY = new Set(["/admin/get-user", "/admin/list-users", "/admin/list-user-sessions", "/admin/has-permission"]);
/** The user fields an event shows. Better Auth's users have no secrets, but a new field must be added here on purpose. */
const SHOWN = ["email", "name", "role", "banned", "banReason", "banExpires", "emailVerified", "image"] as const;

/** Fields an event always shows for these actions, changed or not, so a reader can tell what was asked. */
const ALWAYS: Record<string, readonly Field[]> = { "/admin/update-user": ["email", "name"], "/admin/set-role": ["role"] };

type Field = (typeof SHOWN)[number];
type UserRow = { id: string } & Record<Field, unknown>;

/**
 * The person's row from the before hook, for the after hook of the same call. Keyed by
 * `ctx.context`: Better Auth passes the same object to both hooks of one call (in 1.7, its
 * admin middleware puts the session on it). The e2e test fails if that stops being true.
 */
const targets = new WeakMap<object, UserRow | null>();

export async function beforeAdminCall(ctx: HookContext) {
	if (!isLogged(ctx.path)) return;
	const userId = await targetId(ctx);
	targets.set(ctx.context, userId ? await userRow(userId) : null);
}

/** Never throws: the change is made already, so a failure here must not fail the admin's request. */
export async function afterAdminCall(ctx: HookContext) {
	try {
		await recordCall(ctx);
	} catch (error) {
		console.error(`admin-events: could not record ${ctx.path}:`, error instanceof Error ? error.message : error);
	}
}

async function recordCall(ctx: HookContext) {
	const actor = ctx.context.session?.user;
	if (!isLogged(ctx.path) || isAPIError(ctx.context.returned) || !actor) return;
	const before = targets.get(ctx.context) ?? null;
	const after = before ? await userRow(before.id) : null;
	const action = ctx.path.slice("/admin/".length);
	// A call that names a person but whose person was not found is still recorded, and said loudly.
	const lost = !before && ctx.path !== "/admin/revoke-user-session" && ctx.path !== "/admin/stop-impersonating";
	if (lost) console.error(`admin-events: ${action} by ${actor.email} succeeded, but its person was not found`);
	await recordAdminEvent({
		actor: { id: actor.id, email: actor.email },
		action,
		target: before?.id ?? returnedUserId(ctx.context.returned),
		...(lost ? { after: { targetNotFound: true } } : changes(before, after, ALWAYS[ctx.path] ?? [])),
	});
	if (before && after && before.email !== after.email) await noticeToOldEmail(String(before.email), String(after.email), actor);
}

function isLogged(path: string | undefined): path is string {
	return Boolean(path?.startsWith("/admin/")) && !READ_ONLY.has(path!);
}

/** The person the call acts on. revoke-user-session names a session, so its owner is looked up; the token itself is never logged. */
async function targetId(ctx: HookContext) {
	if (ctx.path === "/admin/revoke-user-session") {
		const token = String(ctx.body?.sessionToken ?? "");
		const [row] = token ? await sql<{ user_id: string }[]>`select "userId" as user_id from sessions where token = ${token}` : [];
		return row?.user_id ?? null;
	}
	// The same as Better Auth's own check (z.coerce.string()), so ["abc"] names the person "abc" here too.
	const id = ctx.body?.userId;
	return id === undefined || id === null ? null : String(id);
}

/** update-user returns the user, and set-role, ban-user and unban-user return { user }. */
function returnedUserId(returned: unknown) {
	const value = returned as { id?: unknown; user?: { id?: unknown } } | null | undefined;
	const id = value?.user?.id ?? value?.id;
	return typeof id === "string" ? id : null;
}

async function userRow(id: string) {
	const [row] = await sql<UserRow[]>`
		select id, email, name, role, banned, "banReason", "banExpires", "emailVerified", image from users where id = ${id}`;
	return row ?? null;
}

/** The fields that changed, and the `always` fields (ALWAYS) even when they did not. */
function changes(before: UserRow | null, after: UserRow | null, always: readonly Field[]) {
	if (!before || !after) return {};
	const fields = SHOWN.filter((field) => always.includes(field) || !same(before[field], after[field]));
	if (!fields.length) return {};
	return { before: pick(before, fields), after: pick(after, fields) };
}

function pick(row: UserRow, fields: readonly Field[]) {
	return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

function same(a: unknown, b: unknown) {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A failed send does not fail the admin's change, which is made already. */
async function noticeToOldEmail(oldEmail: string, newEmail: string, actor: { email: string; name?: string | null }) {
	const admin = actor.name?.trim() ? `${actor.name.trim()} (${actor.email})` : actor.email;
	await sendEmail(emailChangedEmail(oldEmail, newEmail, admin)).catch((error) =>
		console.error("email: the notice of an email change could not be sent:", error instanceof Error ? error.message : error),
	);
}
