import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { sql } from "./db.ts";

/**
 * Secrets that admins set on /admin, such as the OpenRouter key, in the `secrets` table.
 * Each value is encrypted, as Frappe encrypts passwords, so a copy of the database alone
 * does not give it away. The server decrypts a value when it needs it.
 *
 * AES-256-GCM. The key comes from BETTER_AUTH_SECRET (HKDF), so there is no other key to
 * keep. The secret's name is bound to its value, so a value can't be moved to another
 * name. A new BETTER_AUTH_SECRET makes the saved secrets unreadable: enter them again.
 */
const VERSION = "v1";
let encryptionKey: Buffer | undefined;

/** A saved secret that can't be decrypted, because BETTER_AUTH_SECRET changed. */
export class UnreadableSecret extends Error {}

export async function migrateSecrets() {
	await sql`
		create table if not exists secrets (
			name text primary key,
			value text not null,
			updated_by text,
			updated_at timestamptz not null default now()
		)`;
}

/** The secret's value, or undefined when none is saved. Throws UnreadableSecret. */
export async function readSecret(name: string): Promise<string | undefined> {
	const row = await secretRow(name);
	return row && decrypt(name, row.value);
}

/** Who saved the secret and when, without its value. Undefined when none is saved. */
export async function secretInfo(name: string) {
	const row = await secretRow(name);
	if (!row) return undefined;
	return { updatedAt: row.updated_at, updatedBy: row.updated_by_name };
}

export async function saveSecret(name: string, value: string, by: string) {
	await sql`
		insert into secrets (name, value, updated_by) values (${name}, ${encrypt(name, value)}, ${by})
		on conflict (name) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
}

type Row = { value: string; updated_at: Date; updated_by_name: string | null };

async function secretRow(name: string): Promise<Row | undefined> {
	try {
		const [row] = await sql<Row[]>`
			select s.value, s.updated_at, coalesce(nullif(u.name, ''), u.email) as updated_by_name
			from secrets s left join users u on u.id = s.updated_by
			where s.name = ${name}`;
		return row;
	} catch (error) {
		// A script on a database the server never started on has no table: nothing is saved.
		if ((error as { code?: string }).code === "42P01") return undefined;
		throw error;
	}
}

function encrypt(name: string, value: string) {
	return [VERSION, ...cipherParts(key(), name, value)].join(".");
}

function decrypt(name: string, stored: string) {
	const [version, ...parts] = stored.split(".");
	if (version !== VERSION || parts.length !== 3) throw new UnreadableSecret(`The saved ${name} is not in a known format.`);
	const value = decipher(key(), name, parts);
	if (value === undefined) throw new UnreadableSecret(`The saved ${name} can't be decrypted. Did BETTER_AUTH_SECRET change? Enter it again in /admin, Settings.`);
	return value;
}

function key() {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not set, so secrets can't be encrypted or read.");
	return (encryptionKey ??= Buffer.from(hkdfSync("sha256", secret, "ponder-chat", "secrets v1", 32)));
}

/**
 * Secrets kept in other tables, such as the credentials of a person's connectors
 * (mcp/store.ts). The same AES-256-GCM. The context names the table, the row and the
 * column, and is bound as AAD, so a value copied to another row or person does not decrypt.
 *
 * The key is derived from PONDER_ENCRYPTION_KEY when it is set, or else from
 * BETTER_AUTH_SECRET. Each sealed value names its key ("e" or "a"), so values sealed
 * before PONDER_ENCRYPTION_KEY was set stay readable while BETTER_AUTH_SECRET stays the same.
 */
const SEALED = "s1";
const sealKeys = new Map<string, Buffer>();

export function seal(context: string, value: string) {
	const id = process.env.PONDER_ENCRYPTION_KEY ? "e" : "a";
	return [SEALED, id, ...cipherParts(sealKey(id), context, value)].join(".");
}

/** Throws UnreadableSecret when the value can't be decrypted: its key changed, or it belongs to another context. */
export function unseal(context: string, stored: string) {
	const [version, id, ...parts] = stored.split(".");
	if (version !== SEALED || (id !== "e" && id !== "a") || parts.length !== 3) throw new UnreadableSecret("A saved secret is not in a known format.");
	const value = decipher(sealKey(id), context, parts);
	if (value === undefined) throw new UnreadableSecret(`A saved secret can't be decrypted. Did ${id === "e" ? "PONDER_ENCRYPTION_KEY" : "BETTER_AUTH_SECRET"} change?`);
	return value;
}

function sealKey(id: "e" | "a") {
	const secret = id === "e" ? process.env.PONDER_ENCRYPTION_KEY : process.env.BETTER_AUTH_SECRET;
	if (!secret) throw new UnreadableSecret(`${id === "e" ? "PONDER_ENCRYPTION_KEY" : "BETTER_AUTH_SECRET"} is not set, so this secret can't be read.`);
	const cacheKey = `${id}:${secret}`;
	let derived = sealKeys.get(cacheKey);
	if (!derived) sealKeys.set(cacheKey, (derived = Buffer.from(hkdfSync("sha256", secret, "ponder-chat", "sealed values v1", 32))));
	return derived;
}

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
