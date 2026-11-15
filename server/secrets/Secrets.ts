import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "../config.ts";
import { pgCode } from "../runtime/Database.ts";

/**
 * Secrets that admins set on /admin, such as the OpenRouter key, in the `secrets` table.
 * Each value is encrypted, as Frappe encrypts passwords, so a copy of the database alone
 * does not give it away. The server decrypts a value when it needs it.
 *
 * AES-256-GCM. The key comes from BETTER_AUTH_SECRET (HKDF), so there is no other key to
 * keep. The secret's name is bound to its value, so a value can't be moved to another
 * name. A new BETTER_AUTH_SECRET makes the saved secrets unreadable: enter them again.
 *
 * Secrets kept in other tables, such as the credentials of a person's connectors
 * (mcp/store.ts), are sealed: the same AES-256-GCM. The context names the table, the row
 * and the column, and is bound as AAD, so a value copied to another row or person does not decrypt.
 *
 * The seal key is derived from PONDER_ENCRYPTION_KEY when it is set, or else from
 * BETTER_AUTH_SECRET. Each sealed value names its key ("e" or "a"), so values sealed
 * before PONDER_ENCRYPTION_KEY was set stay readable while BETTER_AUTH_SECRET stays the same.
 *
 * Both keys come from the config, which is read when the runtime starts.
 */
const VERSION = "v1";
const SEALED = "s1";

type SealKey = "e" | "a";
const KEY_NAMES = { e: "PONDER_ENCRYPTION_KEY", a: "BETTER_AUTH_SECRET" } as const;

/**
 * A saved secret that can't be decrypted: its key changed (BETTER_AUTH_SECRET or
 * PONDER_ENCRYPTION_KEY), it is not in a known format, or it belongs to another context.
 * Its fields name the secret and the key, never a value.
 */
export class UnreadableSecret extends Schema.TaggedError<UnreadableSecret>()("UnreadableSecret", {
	/** What is wrong: an unknown format, a value the key does not open, or no key at all. */
	problem: Schema.Literals(["format", "decrypt", "no-key"]),
	/** The name of a secret in the `secrets` table, such as "openrouter_api_key". None for a sealed value. */
	secret: Schema.optional(Schema.String),
	/** The variable the key comes from. */
	key: Schema.optional(Schema.Literals(["PONDER_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"])),
}) {
	override get message() {
		if (this.secret !== undefined) {
			if (this.problem === "format") return `The saved ${this.secret} is not in a known format.`;
			return `The saved ${this.secret} can't be decrypted. Did BETTER_AUTH_SECRET change? Enter it again in /admin, Settings.`;
		}
		if (this.problem === "format") return "A saved secret is not in a known format.";
		if (this.problem === "no-key") return `${this.key} is not set, so this secret can't be read.`;
		return `A saved secret can't be decrypted. Did ${this.key} change?`;
	}
}

/** Who saved a secret and when, without its value. */
export type SecretInfo = { updatedAt: Date; updatedBy: string | null };

const SecretRow = Schema.Struct({ value: Schema.String, updated_at: Schema.Date, updated_by_name: Schema.NullOr(Schema.String) });

export class Secrets extends Context.Service<
	Secrets,
	{
		/** Creates the `secrets` table. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The secret's value, or none when none is saved. */
		readonly read: (name: string) => Effect.Effect<Option.Option<string>, UnreadableSecret | SqlError>;
		/** Who saved the secret and when, without its value. None when none is saved. */
		readonly info: (name: string) => Effect.Effect<Option.Option<SecretInfo>, SqlError>;
		/** Saves the secret, encrypted, as saved by the person `by`. */
		readonly save: (name: string, value: string, by: string) => Effect.Effect<void, SqlError>;
		/** Seals a value for another table, bound to `context` (such as "mcp_connections:<id>:credentials"). */
		readonly seal: (context: string, value: string) => Effect.Effect<string, UnreadableSecret>;
		/** The plain value of a sealed one. Fails when its key changed, or it belongs to another context. */
		readonly unseal: (context: string, stored: string) => Effect.Effect<string, UnreadableSecret>;
	}
>()("ponder/secrets/Secrets") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const config = yield* PonderConfig.PonderConfig;

	// The keys, derived once from the config. Missing when their variable is not set.
	const derive = (secret: Option.Option<Redacted.Redacted>, info: string) =>
		Option.map(secret, (value) => Buffer.from(hkdfSync("sha256", Redacted.value(value), "ponder-chat", info, 32)));
	const secretsKey = derive(config.betterAuthSecret, "secrets v1");
	const sealKeys = { e: derive(config.encryptionKey, "sealed values v1"), a: derive(config.betterAuthSecret, "sealed values v1") };
	const newSealKey: SealKey = Option.isSome(config.encryptionKey) ? "e" : "a";

	// A table's secrets can't be encrypted or read without BETTER_AUTH_SECRET. No caller can act on that: a defect.
	const keyForSecrets = Option.match(secretsKey, {
		onNone: () => Effect.die(new Error("BETTER_AUTH_SECRET is not set, so secrets can't be encrypted or read.")),
		onSome: Effect.succeed,
	});
	const sealKey = (id: SealKey) =>
		Option.match(sealKeys[id], {
			onNone: () => Effect.fail(new UnreadableSecret({ problem: "no-key", key: KEY_NAMES[id] })),
			onSome: Effect.succeed,
		});

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists secrets (
				name text primary key,
				value text not null,
				updated_by text,
				updated_at timestamptz not null default now()
			)`;
	});

	const findSecret = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: SecretRow,
		execute: (name) => sql`
			select s.value, s.updated_at, coalesce(nullif(u.name, ''), u.email) as updated_by_name
			from secrets s left join users u on u.id = s.updated_by
			where s.name = ${name}`,
	});

	const secretRow = (name: string) =>
		findSecret(name).pipe(
			Effect.catchTags({
				SchemaError: Effect.die,
				// A script on a database the server never started on has no table: nothing is saved.
				SqlError: (error) => (pgCode(error) === "42P01" ? Effect.succeedNone : Effect.fail(error)),
			}),
		);

	const read = Effect.fn("Secrets.read")(function* (name: string) {
		const row = yield* secretRow(name);
		if (Option.isNone(row)) return Option.none<string>();
		const [version, ...parts] = row.value.value.split(".");
		if (version !== VERSION || parts.length !== 3) return yield* new UnreadableSecret({ problem: "format", secret: name });
		const value = decipher(yield* keyForSecrets, name, parts);
		if (value === undefined) return yield* new UnreadableSecret({ problem: "decrypt", secret: name });
		return Option.some(value);
	});

	const info = Effect.fn("Secrets.info")(function* (name: string) {
		const row = yield* secretRow(name);
		return Option.map(row, (found): SecretInfo => ({ updatedAt: found.updated_at, updatedBy: found.updated_by_name }));
	});

	const save = Effect.fn("Secrets.save")(function* (name: string, value: string, by: string) {
		const stored = [VERSION, ...cipherParts(yield* keyForSecrets, name, value)].join(".");
		yield* sql`
			insert into secrets (name, value, updated_by) values (${name}, ${stored}, ${by})
			on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
	});

	// Not traced: a connector's credentials are sealed and unsealed for each of its calls, and the work is a few microseconds.
	const seal = Effect.fnUntraced(function* (context: string, value: string) {
		return [SEALED, newSealKey, ...cipherParts(yield* sealKey(newSealKey), context, value)].join(".");
	});

	const unseal = Effect.fnUntraced(function* (context: string, stored: string) {
		const [version, id, ...parts] = stored.split(".");
		if (version !== SEALED || (id !== "e" && id !== "a") || parts.length !== 3) return yield* new UnreadableSecret({ problem: "format" });
		const value = decipher(yield* sealKey(id), context, parts);
		if (value === undefined) return yield* new UnreadableSecret({ problem: "decrypt", key: KEY_NAMES[id] });
		return value;
	});

	return Secrets.of({ migrate, read, info, save, seal, unseal });
});

export const layer = Layer.effect(Secrets, make);

function cipherParts(cipherKey: Buffer, aad: string, value: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
	cipher.setAAD(Buffer.from(aad));
	const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url"));
}

/** The plain value, or undefined when the key or the AAD is wrong. */
function decipher(cipherKey: Buffer, aad: string, [iv, tag, data]: string[]) {
	try {
		const decipher = createDecipheriv("aes-256-gcm", cipherKey, Buffer.from(iv!, "base64url"));
		decipher.setAAD(Buffer.from(aad));
		decipher.setAuthTag(Buffer.from(tag!, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(data!, "base64url")), decipher.final()]).toString("utf8");
	} catch {
		return undefined;
	}
}
