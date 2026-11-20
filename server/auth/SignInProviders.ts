import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { pgCode } from "../runtime/Database.ts";
import * as Secrets from "../secrets/Secrets.ts";
import { checkedSettings, InvalidSettings, MICROSOFT, NO_SETTINGS, SIGN_UPS, type MicrosoftProvider, type MicrosoftSettings, type MicrosoftStatus } from "./microsoft.ts";

/**
 * The ways to sign in that admins set on /admin, in `sign_in_providers`: Microsoft
 * (microsoft.ts), and whether sign-in by email is on. A provider's client secret is sealed
 * (secrets/Secrets.ts), so a copy of the database alone does not give it away.
 *
 * Sign-in by email is on unless an admin turned it off, and it can be off only while
 * Microsoft is on and works. When Microsoft goes off (an admin turns it off, or its secret
 * can't be read), email is on again by itself: there is always a way in.
 *
 * Better Auth takes its providers when it is made, so Auth.ts makes it again after a
 * change: `active` carries a version for that. Every sign-in request asks for `active`, so
 * it is kept in memory. A change from /admin shows at once in this process.
 */

/** The ways to sign in now, and a number that is new after each change. */
export type Active = { version: number; microsoft: Option.Option<MicrosoftProvider>; email: boolean };
type Ways = Omit<Active, "version">;

/** Email sign-in can't go off while Microsoft is off: nobody could sign in. */
export class EmailNeeded extends Schema.TaggedError<EmailNeeded>()("EmailNeeded", {}) {
	override get message() {
		return "Turn on sign-in with Microsoft first. Without it, nobody could sign in.";
	}
}

const EMAIL = "email";

const ProviderRow = Schema.Struct({
	enabled: Schema.Boolean,
	client_id: Schema.String,
	client_secret: Schema.NullOr(Schema.String),
	tenant_id: Schema.String,
	sign_ups: Schema.Literals(SIGN_UPS),
	allowed_domains: Schema.Array(Schema.String),
	updated_at: Schema.Date,
});
type ProviderRow = typeof ProviderRow.Type;

export class SignInProviders extends Context.Service<
	SignInProviders,
	{
		/** Creates the table. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Microsoft's settings, as /admin shows them: without the client secret. */
		readonly microsoft: Effect.Effect<MicrosoftStatus, SqlError>;
		/**
		 * Checks the settings (microsoft.ts) and saves them. Without a client secret, the saved one
		 * stays. A new tenant has other accounts: the links to the old tenant's accounts go.
		 */
		readonly saveMicrosoft: (
			settings: MicrosoftSettings,
			clientSecret: string | undefined,
			by: string,
		) => Effect.Effect<MicrosoftStatus, InvalidSettings | SqlError>;
		/**
		 * Turns sign-in by email on or off. Off only while Microsoft is on and works (EmailNeeded).
		 * Whether it is on after.
		 */
		readonly saveEmail: (enabled: boolean, by: string) => Effect.Effect<boolean, EmailNeeded | SqlError>;
		/** What sign-in runs on now: Microsoft, when it is on and complete, and email unless it is off. Kept in memory. */
		readonly active: Effect.Effect<Active, SqlError>;
		/** Whether the person has a Microsoft account linked. */
		readonly isLinked: (userId: string) => Effect.Effect<boolean, SqlError>;
		/**
		 * Forgets which Microsoft account the person signs in with, so their next sign-in with
		 * Microsoft links the account it shows (Auth.ts). False when none was linked.
		 */
		readonly unlink: (userId: string) => Effect.Effect<boolean, SqlError>;
	}
>()("ponder/auth/SignInProviders") {}

const SEAL_CONTEXT = `sign_in_providers:${MICROSOFT}:client_secret`;

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const secrets = yield* Secrets.Secrets;
	// What sign-in runs on, in memory, with a version that each change makes new. A read keeps
	// its answer only if no change came while it ran: else it could put back a provider just turned off.
	const cached = yield* Ref.make({ version: 0, ways: Option.none<Ways>() });

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists sign_in_providers (
				id text primary key,
				enabled boolean not null default false,
				client_id text not null default '',
				client_secret text,
				tenant_id text not null default '',
				sign_ups text not null default 'invited',
				allowed_domains jsonb not null default '[]',
				updated_by text,
				updated_at timestamptz not null default now()
			)`;
	});

	const findProvider = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: ProviderRow,
		execute: (id) => sql`select enabled, client_id, client_secret, tenant_id, sign_ups, allowed_domains, updated_at from sign_in_providers where id = ${id}`,
	});

	const rowOf = (id: string) =>
		findProvider(id).pipe(
			Effect.catchTags({
				SchemaError: Effect.die,
				// A script or a check on a database the server never started on has no table: no provider is set up.
				SqlError: (error) => (pgCode(error) === "42P01" ? Effect.succeedNone : Effect.fail(error)),
			}),
		);
	const row = rowOf(MICROSOFT);
	// Email's row has only `enabled`. With no row, email is on.
	const emailSetting = Effect.map(rowOf(EMAIL), (found) => Option.match(found, { onNone: () => true, onSome: (email) => email.enabled }));

	const microsoft = Effect.gen(function* () {
		const found = yield* row;
		const sealed = Option.getOrNull(Option.map(found, (provider) => provider.client_secret));
		const readable = sealed === null ? true : yield* secrets.unseal(SEAL_CONTEXT, sealed).pipe(Effect.as(true), Effect.catchTags({ UnreadableSecret: () => Effect.succeed(false) }));
		return statusOf(found, !readable);
	}).pipe(Effect.withSpan("SignInProviders.microsoft"));

	const forget = Ref.update(cached, (now) => ({ version: now.version + 1, ways: Option.none<Ways>() }));

	const saveMicrosoft = Effect.fn("SignInProviders.saveMicrosoft")(function* (input: MicrosoftSettings, clientSecret: string | undefined, by: string) {
		const secret = clientSecret?.trim() || undefined;
		const before = yield* microsoft;
		// A saved secret that can't be read is no secret: turning sign-in on needs a new one.
		const settings = checkedSettings(input, { clientSecret: secret, hasSecret: before.hasSecret && !before.secretUnreadable });
		if (settings instanceof InvalidSettings) return yield* settings;
		// Sealing fails only with no key at all (BETTER_AUTH_SECRET), and the server does not start without one.
		const sealed = secret === undefined ? null : yield* secrets.seal(SEAL_CONTEXT, secret).pipe(Effect.catchTags({ UnreadableSecret: Effect.die }));
		const write = sql`
			insert into sign_in_providers (id, enabled, client_id, client_secret, tenant_id, sign_ups, allowed_domains, updated_by)
			values (${MICROSOFT}, ${settings.enabled}, ${settings.clientId}, ${sealed}, ${settings.tenantId}, ${settings.signUps}, ${sql.json(settings.allowedDomains)}, ${by})
			on conflict (id) do update set enabled = excluded.enabled, client_id = excluded.client_id,
				client_secret = coalesce(excluded.client_secret, sign_in_providers.client_secret), tenant_id = excluded.tenant_id,
				sign_ups = excluded.sign_ups, allowed_domains = excluded.allowed_domains, updated_by = excluded.updated_by, updated_at = now()`;
		// An account's id means something in its own tenant only. With another tenant, every linked person
		// would be refused as "linked to another account": the links go, and each person links again at their next sign-in.
		const newTenant = before.tenantId !== "" && before.tenantId !== settings.tenantId;
		// Memory is told even when the write fails: it may have reached the database before the failure did.
		yield* sql
			.withTransaction(
				Effect.gen(function* () {
					yield* write;
					if (newTenant) yield* sql`delete from accounts where "providerId" = ${MICROSOFT}`;
					// Microsoft off: email is the way in again, and its setting says so.
					if (!settings.enabled) yield* sql`update sign_in_providers set enabled = true, updated_by = ${by}, updated_at = now() where id = ${EMAIL} and not enabled`;
				}),
			)
			.pipe(Effect.ensuring(forget));
		return yield* microsoft;
	});

	const saveEmail = Effect.fn("SignInProviders.saveEmail")(function* (enabled: boolean, by: string) {
		if (!enabled && Option.isNone((yield* active).microsoft)) return yield* new EmailNeeded();
		yield* sql`
			insert into sign_in_providers (id, enabled, updated_by) values (${EMAIL}, ${enabled}, ${by})
			on conflict (id) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`.pipe(Effect.ensuring(forget));
		return (yield* active).email;
	});

	const provider = Effect.gen(function* () {
		const found = yield* row;
		if (Option.isNone(found) || !found.value.enabled || found.value.client_secret === null) return Option.none<MicrosoftProvider>();
		const { client_id, tenant_id, sign_ups, allowed_domains, client_secret } = found.value;
		// saveMicrosoft turns it on only when it is complete. A row changed by hand that is not stays off.
		if (!client_id || !tenant_id || !allowed_domains.length) return Option.none<MicrosoftProvider>();
		// A secret that can't be read (its key changed) turns Microsoft off. Sign-in by email goes on.
		return yield* secrets.unseal(SEAL_CONTEXT, client_secret).pipe(
			Effect.map((clientSecret) => Option.some<MicrosoftProvider>({ tenantId: tenant_id, clientId: client_id, clientSecret, signUps: sign_ups, allowedDomains: allowed_domains })),
			Effect.catchTags({
				UnreadableSecret: (error) => Effect.as(Effect.logError("sign-in: Microsoft is off, because its client secret can't be read:", error.message), Option.none<MicrosoftProvider>()),
			}),
		);
	});

	// No span: every sign-in request asks, nearly always from memory.
	const active: Effect.Effect<Active, SqlError> = Effect.gen(function* () {
		const known = yield* Ref.get(cached);
		if (Option.isSome(known.ways)) return { version: known.version, ...known.ways.value };
		const found = yield* provider;
		// Email is off only while Microsoft works: with Microsoft off, it is on whatever its row says.
		const ways: Ways = { microsoft: found, email: Option.isNone(found) || (yield* emailSetting) };
		yield* Ref.update(cached, (now) => (now.version === known.version ? { version: now.version, ways: Option.some(ways) } : now));
		return { version: known.version, ...ways };
	});

	// Better Auth's table of linked accounts (Auth.ts): one row for a person's Microsoft account.
	const isLinked = Effect.fn("SignInProviders.isLinked")(function* (userId: string) {
		const rows = yield* sql`select 1 from accounts where "userId" = ${userId} and "providerId" = ${MICROSOFT} limit 1`;
		return rows.length > 0;
	});

	const unlink = Effect.fn("SignInProviders.unlink")(function* (userId: string) {
		const rows = yield* sql`delete from accounts where "userId" = ${userId} and "providerId" = ${MICROSOFT} returning id`;
		return rows.length > 0;
	});

	return SignInProviders.of({ migrate, microsoft, saveMicrosoft, saveEmail, active, isLinked, unlink });
});

export const layer = Layer.effect(SignInProviders, make);

function statusOf(row: Option.Option<ProviderRow>, secretUnreadable: boolean): MicrosoftStatus {
	if (Option.isNone(row)) return { ...NO_SETTINGS, hasSecret: false, secretUnreadable: false, updatedAt: null };
	const { enabled, client_id, client_secret, tenant_id, sign_ups, allowed_domains, updated_at } = row.value;
	return {
		enabled,
		tenantId: tenant_id,
		clientId: client_id,
		signUps: sign_ups,
		allowedDomains: allowed_domains,
		hasSecret: client_secret !== null,
		secretUnreadable,
		updatedAt: updated_at.toISOString(),
	};
}
