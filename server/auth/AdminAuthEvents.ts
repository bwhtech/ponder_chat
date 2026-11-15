import * as PgClient from "@effect/sql-pg/PgClient";
import { isAPIError } from "better-auth/api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as AdminEvents from "../admin/AdminEvents.ts";
import * as Mailer from "../email/Mailer.ts";
import { sqlMessage } from "../runtime/Database.ts";

/**
 * Better Auth's admin endpoints in the admin activity log (admin/AdminEvents.ts). The browser
 * can call them at /api/auth/admin/*, and /admin calls them through auth.api (AdminActions.ts),
 * so Auth.ts logs them here, in its hooks, and the admin routes do not.
 * Every admin endpoint that changes something is logged, and only when it succeeds.
 *
 * The after hook sees only the result, so the before hook reads the person's row first.
 * Both hooks of one call get the same `ctx.context` object (Better Auth puts the admin's
 * session on it in between), so the row waits there, in a WeakMap.
 *
 * When an admin changes someone's email, the old address gets a notice: that address no
 * longer signs in to the account, so its owner must hear about it.
 */
export type HookContext = {
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

// Each field as it comes back: text, boolean, or timestamptz as a Date.
const UserRow = Schema.Struct({
	id: Schema.String,
	email: Schema.Unknown,
	name: Schema.Unknown,
	role: Schema.Unknown,
	banned: Schema.Unknown,
	banReason: Schema.Unknown,
	banExpires: Schema.Unknown,
	emailVerified: Schema.Unknown,
	image: Schema.Unknown,
});
type UserRow = typeof UserRow.Type;
const SessionOwnerRow = Schema.Struct({ user_id: Schema.String });

export class AdminAuthEvents extends Context.Service<
	AdminAuthEvents,
	{
		/** Better Auth's before hook: reads the row of the person an admin call acts on. */
		readonly before: (ctx: HookContext) => Effect.Effect<void, SqlError>;
		/** Better Auth's after hook: records the call. Never fails: the change is made already, so a failure here must not fail the admin's request. */
		readonly after: (ctx: HookContext) => Effect.Effect<void>;
	}
>()("ponder/auth/AdminAuthEvents") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const adminEvents = yield* AdminEvents.AdminEvents;
	const mailer = yield* Mailer.Mailer;

	/**
	 * The person's row from the before hook, for the after hook of the same call. Keyed by
	 * `ctx.context`: Better Auth passes the same object to both hooks of one call (in 1.7, its
	 * admin middleware puts the session on it). The e2e test fails if that stops being true.
	 */
	const targets = new WeakMap<object, UserRow | null>();

	const findUser = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: UserRow,
		execute: (id) => sql`
			select id, email, name, role, banned, "banReason", "banExpires", "emailVerified", image from users where id = ${id}`,
	});
	const findSessionOwner = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: SessionOwnerRow,
		execute: (token) => sql`select "userId" as user_id from sessions where token = ${token}`,
	});

	const userRow = (id: string) => findUser(id).pipe(Effect.map(Option.getOrNull), Effect.catchTags({ SchemaError: Effect.die }));

	/** The person the call acts on. revoke-user-session names a session, so its owner is looked up; the token itself is never logged. */
	const targetId = Effect.fnUntraced(function* (ctx: HookContext) {
		if (ctx.path === "/admin/revoke-user-session") {
			const token = String(ctx.body?.sessionToken ?? "");
			if (!token) return null;
			const row = yield* findSessionOwner(token).pipe(Effect.catchTags({ SchemaError: Effect.die }));
			return Option.match(row, { onNone: () => null, onSome: (found) => found.user_id });
		}
		// The same as Better Auth's own check (z.coerce.string()), so ["abc"] names the person "abc" here too.
		const id = ctx.body?.userId;
		return id === undefined || id === null ? null : String(id);
	});

	const before = Effect.fn("AdminAuthEvents.before")(function* (ctx: HookContext) {
		if (!isLogged(ctx.path)) return;
		const userId = yield* targetId(ctx);
		targets.set(ctx.context, userId ? yield* userRow(userId) : null);
	});

	/** A failed send does not fail the admin's change, which is made already. */
	const noticeToOldEmail = (oldEmail: string, newEmail: string, actor: { email: string; name?: string | null }) => {
		const admin = actor.name?.trim() ? `${actor.name.trim()} (${actor.email})` : actor.email;
		return mailer
			.send(Mailer.emailChangedEmail(oldEmail, newEmail, admin))
			.pipe(Effect.catchTags({ EmailNotSent: (error) => Effect.logError("email: the notice of an email change could not be sent:", error.message) }));
	};

	const recordCall = Effect.fnUntraced(function* (ctx: HookContext) {
		const actor = ctx.context.session?.user;
		if (!isLogged(ctx.path) || isAPIError(ctx.context.returned) || !actor) return;
		const before = targets.get(ctx.context) ?? null;
		const after = before ? yield* userRow(before.id) : null;
		const action = ctx.path.slice("/admin/".length);
		// A call that names a person but whose person was not found is still recorded, and said loudly.
		const lost = !before && ctx.path !== "/admin/revoke-user-session" && ctx.path !== "/admin/stop-impersonating";
		if (lost) yield* Effect.logError(`admin-events: ${action} by ${actor.email} succeeded, but its person was not found`);
		yield* adminEvents.record({
			actor: { id: actor.id, email: actor.email },
			action,
			target: before?.id ?? returnedUserId(ctx.context.returned),
			...(lost ? { after: { targetNotFound: true } } : changes(before, after, ALWAYS[ctx.path] ?? [])),
		});
		if (before && after && before.email !== after.email) yield* noticeToOldEmail(String(before.email), String(after.email), actor);
	});

	const after = Effect.fn("AdminAuthEvents.after")(function* (ctx: HookContext) {
		const failed = `admin-events: could not record ${ctx.path}:`;
		yield* recordCall(ctx).pipe(
			Effect.catchTags({ SqlError: (error) => Effect.logError(failed, sqlMessage(error)) }),
			Effect.catchDefect((defect) => Effect.logError(failed, defect instanceof Error ? defect.message : defect)),
		);
	});

	return AdminAuthEvents.of({ before, after });
});

export const layer = Layer.effect(AdminAuthEvents, make);

function isLogged(path: string | undefined): path is string {
	return Boolean(path?.startsWith("/admin/")) && !READ_ONLY.has(path!);
}

/** update-user returns the user, and set-role, ban-user and unban-user return { user }. */
function returnedUserId(returned: unknown) {
	const nested = Predicate.hasProperty(returned, "user") && Predicate.hasProperty(returned.user, "id") ? returned.user.id : undefined;
	const id = nested ?? (Predicate.hasProperty(returned, "id") ? returned.id : undefined);
	return Predicate.isString(id) ? id : null;
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
