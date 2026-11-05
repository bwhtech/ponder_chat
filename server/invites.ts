import { sql } from "./db.ts";

/**
 * Who may sign in. The pilot is invite-only: an email must be in `allowed_emails`
 * (scripts/invite.ts adds and removes them) or in CHAT_ALLOWED_EMAILS. CHAT_OPEN_SIGNUP=1
 * lets anyone in, for local development.
 *
 * A sign-in link is sent only to an allowed email, and a new account is created only for
 * one. The page says "check your email" either way, so it does not tell who is invited.
 */
const OPEN = process.env.CHAT_OPEN_SIGNUP === "1";
const FROM_ENV = new Set(
	(process.env.CHAT_ALLOWED_EMAILS ?? "")
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean),
);

export async function migrateInvites() {
	await sql`
		create table if not exists allowed_emails (
			email text primary key,
			note text not null default '',
			created_at timestamptz not null default now()
		)`;
}

export async function isAllowed(email: string) {
	const normalized = email.trim().toLowerCase();
	if (OPEN || FROM_ENV.has(normalized)) return true;
	const [row] = await sql`select 1 from allowed_emails where email = ${normalized}`;
	return Boolean(row);
}

export async function allow(email: string, note = "") {
	await sql`insert into allowed_emails (email, note) values (${email.trim().toLowerCase()}, ${note}) on conflict (email) do update set note = excluded.note`;
}

export async function disallow(email: string) {
	const rows = await sql`delete from allowed_emails where email = ${email.trim().toLowerCase()} returning email`;
	return rows.length > 0;
}

export async function listAllowed() {
	return sql<{ email: string; note: string; created_at: Date }[]>`select email, note, created_at from allowed_emails order by created_at`;
}
