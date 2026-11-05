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
	// Who invited them (a user id; null for scripts/invite.ts), and their own daily limit, if any.
	await sql`alter table allowed_emails add column if not exists invited_by text`;
	await sql`alter table allowed_emails add column if not exists daily_credits integer`;
}

export async function isAllowed(email: string) {
	const normalized = email.trim().toLowerCase();
	if (OPEN || FROM_ENV.has(normalized)) return true;
	const [row] = await sql`select 1 from allowed_emails where email = ${normalized}`;
	return Boolean(row);
}

export type Invite = { note?: string; invitedBy?: string | null; dailyCredits?: number | null };

/** Invites an email, or updates the note of one invited before. */
export async function allow(email: string, { note = "", invitedBy = null, dailyCredits = null }: Invite = {}) {
	await sql`
		insert into allowed_emails (email, note, invited_by, daily_credits)
		values (${email.trim().toLowerCase()}, ${note}, ${invitedBy}, ${dailyCredits})
		on conflict (email) do update set note = excluded.note`;
}

/** Sets the daily limit an invited person starts with; null for the default. */
export async function setInviteCredits(email: string, credits: number | null) {
	const rows = await sql`update allowed_emails set daily_credits = ${credits} where email = ${email.trim().toLowerCase()} returning email`;
	return rows.length > 0;
}

/**
 * On a person's first sign-in (auth.ts): the daily limit from their invite becomes
 * their own limit. Later changes are made to the person, not the invite.
 */
export async function applyInvite(user: { id: string; email: string }) {
	await sql`
		insert into credit_limits (user_id, daily_credits)
		select ${user.id}, daily_credits from allowed_emails
		where email = ${user.email.trim().toLowerCase()} and daily_credits is not null
		on conflict (user_id) do nothing`;
}

export async function disallow(email: string) {
	const rows = await sql`delete from allowed_emails where email = ${email.trim().toLowerCase()} returning email`;
	return rows.length > 0;
}

export async function listAllowed() {
	return sql<{ email: string; note: string; created_at: Date }[]>`select email, note, created_at from allowed_emails order by created_at`;
}
