import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * People with an account: Better Auth's `users` (auth/Auth.ts), read and changed here
 * for what Ponder itself needs.
 *
 * Admins are people whose role is "admin". The role is a column of `users` from Better
 * Auth's admin plugin; everyone else is "user". scripts/admin.ts grants and revokes it
 * straight in the database, because a terminal has no admin session.
 */
export type Role = "admin" | "user";

const RoleRow = Schema.Struct({ role: Schema.NullOr(Schema.String) });
const IdRow = Schema.Struct({ id: Schema.String });
const EmailRow = Schema.Struct({ email: Schema.String });
const AdminRow = Schema.Struct({ email: Schema.String, role: Schema.String, created_at: Schema.Date });

export type AdminRow = typeof AdminRow.Type;

const PersonRow = Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String });

/** A person in the people picker (GET /api/people). */
export type PersonRow = typeof PersonRow.Type;

export class Accounts extends Context.Service<
	Accounts,
	{
		/** The person's role, read from the database: the session in the cookie can be five minutes old. */
		readonly roleOf: (userId: string) => Effect.Effect<Role, SqlError>;
		readonly isAdmin: (userId: string) => Effect.Effect<boolean, SqlError>;
		/** False when the email has no account yet. */
		readonly setRole: (email: string, role: Role) => Effect.Effect<boolean, SqlError>;
		/** The admins, by email, oldest account first (scripts/admin.ts). */
		readonly listAdmins: Effect.Effect<ReadonlyArray<AdminRow>, SqlError>;
		/** Whether someone has an account, by user id or by email. */
		readonly hasAccount: (idOrEmail: string) => Effect.Effect<boolean, SqlError>;
		/** The person's email; none when there is no such account. */
		readonly emailOf: (userId: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/** The account of an email; none before the person's first sign-in. */
		readonly idOfEmail: (email: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/**
		 * People whose name or email has the text, without case, by name: at most 20. Any
		 * signed-in person may search: everyone in the organisation sees everyone. Blocked
		 * people are left out. An empty text gives the first 20.
		 */
		readonly search: (text: string) => Effect.Effect<ReadonlyArray<PersonRow>, SqlError>;
	}
>()("ponder/people/Accounts") {}

/** Better Auth keeps several roles as "admin,user", so "admin" wins if it is one of them. */
export const roleFrom = (role: string | null): Role => ((role ?? "").split(",").some((one) => one.trim() === "admin") ? "admin" : "user");

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const findRole = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: RoleRow,
		execute: (userId) => sql`select role from users where id = ${userId}`,
	});
	const findAdmins = SqlSchema.findAll({
		Request: Schema.Void,
		Result: AdminRow,
		execute: () => sql`
			select email, role, "createdAt" as created_at from users
			where 'admin' = any(string_to_array(replace(role, ' ', ''), ','))
			order by "createdAt"`,
	});
	const findEmail = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: EmailRow,
		execute: (userId) => sql`select email from users where id = ${userId}`,
	});
	const findId = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: IdRow,
		execute: (email) => sql`select id from users where lower(email) = ${email}`,
	});

	const findPeople = SqlSchema.findAll({
		Request: Schema.String,
		Result: PersonRow,
		execute: (pattern) => sql`
			select id, coalesce(name, '') as name, email from users
			where (name ilike ${pattern} escape '\\' or email ilike ${pattern} escape '\\') and banned is not true
			order by lower(coalesce(name, '')), lower(email) limit 20`,
	});

	const roleOf = Effect.fn("Accounts.roleOf")(function* (userId: string) {
		const row = yield* findRole(userId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return roleFrom(Option.match(row, { onNone: () => null, onSome: (found) => found.role }));
	});

	const isAdmin = Effect.fn("Accounts.isAdmin")(function* (userId: string) {
		return (yield* roleOf(userId)) === "admin";
	});

	const setRole = Effect.fn("Accounts.setRole")(function* (email: string, role: Role) {
		const rows = yield* sql`update users set role = ${role}, "updatedAt" = now() where lower(email) = ${email.trim().toLowerCase()} returning id`;
		return rows.length > 0;
	});

	const listAdmins = findAdmins(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }), Effect.withSpan("Accounts.listAdmins"));

	const hasAccount = Effect.fn("Accounts.hasAccount")(function* (idOrEmail: string) {
		const rows = yield* sql`select 1 from users where id = ${idOrEmail} or lower(email) = ${idOrEmail.toLowerCase()}`;
		return rows.length > 0;
	});

	const emailOf = Effect.fn("Accounts.emailOf")(function* (userId: string) {
		const row = yield* findEmail(userId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.email);
	});

	const idOfEmail = Effect.fn("Accounts.idOfEmail")(function* (email: string) {
		const row = yield* findId(email.trim().toLowerCase()).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.id);
	});

	const search = Effect.fn("Accounts.search")(function* (text: string) {
		// The text is matched as it is: % and _ in it are not wildcards.
		const pattern = `%${text.trim().replace(/[\\%_]/g, (special) => `\\${special}`)}%`;
		return yield* findPeople(pattern).pipe(Effect.catchTags({ SchemaError: Effect.die }));
	});

	return Accounts.of({ roleOf, isAdmin, setRole, listAdmins, hasAccount, emailOf, idOfEmail, search });
});

export const layer = Layer.effect(Accounts, make);
