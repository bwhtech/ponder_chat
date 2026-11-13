import { sql } from "../db.ts";
import { creditsByModel, limitsToday, Usage } from "./usage.ts";

/**
 * People for /admin: everyone with an account (Better Auth's `users`), and everyone
 * invited who has not signed in yet (`allowed_emails`). An invited person's id is their
 * email, since they have no account yet. Only usage numbers, never chats.
 */
export type Status = "active" | "invited" | "banned";

export type Person = {
	/** The user id, or the email for an invite without an account. */
	id: string;
	name: string;
	email: string;
	role: "admin" | "user";
	status: Status;
	note: string;
	invitedAt: string | null;
	invitedBy: string | null;
	joinedAt: string | null;
	lastActive: string | null;
	/** Their own daily limit, or null for the default. */
	dailyCredits: number | null;
	banReason: string | null;
	banExpires: string | null;
	/** `limit` includes `extra`, the credits admins gave for today. */
	today: { used: number; limit: number; extra: number };
	/** Credits over the last 7 days. */
	week: number;
};

type Row = {
	id: string | null;
	name: string | null;
	email: string;
	role: string | null;
	banned: boolean | null;
	ban_reason: string | null;
	ban_expires: Date | null;
	joined_at: Date | null;
	note: string | null;
	invited_at: Date | null;
	inviter: string | null;
	invite_credits: number | null;
	last_active: Date | null;
};

export async function listPeople(): Promise<Person[]> {
	const [rows, usage, limits] = await Promise.all([peopleRows(), Usage.load(7), limitsToday()]);
	return rows.map((row) => toPerson(row, usage, limits));
}

/** One person, by user id or (for an invite) by email, with 30 days of usage, models, sessions and chats. */
export async function personDetail(id: string) {
	const [row] = await peopleRows(id);
	if (!row) return null;
	const userId = row.id ?? "";
	const [usage, limits, models, sessions, [chats]] = await Promise.all([
		Usage.load(30, userId),
		limitsToday(),
		row.id ? creditsByModel(30, userId) : [],
		row.id ? sessionsOf(userId) : [],
		sql<{ count: number }[]>`select count(*)::int as count from threads where owner = ${userId}`,
	]);
	return {
		person: toPerson(row, usage, limits),
		days: usage.series(userId),
		models,
		sessions,
		chats: chats.count,
	};
}

/** Names and emails for a list of user ids, for requests and the admins list. */
export async function namesOf(ids: string[]) {
	const rows = ids.length ? await sql<{ id: string; name: string; email: string }[]>`select id, name, email from users where id in ${sql(ids)}` : [];
	return new Map(rows.map((row) => [row.id, { id: row.id, name: displayName(row.name, row.email), email: row.email }]));
}

export async function listAdmins() {
	const rows = await sql<{ id: string; name: string; email: string }[]>`
		select id, name, email from users where 'admin' = any(string_to_array(replace(coalesce(role, ''), ' ', ''), ','))
		order by "createdAt"`;
	return rows.map((row) => ({ id: row.id, name: displayName(row.name, row.email), email: row.email }));
}

/** "Chrome on macOS", from a session's user agent. */
export function deviceName(userAgent: string | null) {
	const agent = userAgent ?? "";
	const browser = BROWSERS.find(([, test]) => test.test(agent))?.[0] ?? "Unknown browser";
	const system = SYSTEMS.find(([, test]) => test.test(agent))?.[0];
	return system ? `${browser} on ${system}` : browser;
}

/** People have no name until they set one, so the start of the email stands in. */
export function displayName(name: string | null, email: string) {
	return name?.trim() || email.split("@")[0];
}

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari", and an iPhone "like Mac OS X".
const BROWSERS: [string, RegExp][] = [
	["Edge", /Edg(e|A|iOS)?\//],
	["Opera", /OPR\/|Opera/],
	["Samsung Internet", /SamsungBrowser/],
	["Firefox", /Firefox\/|FxiOS/],
	["Chrome", /Chrome\/|CriOS/],
	["Safari", /Safari\//],
];
const SYSTEMS: [string, RegExp][] = [
	["iPhone", /iPhone/],
	["iPad", /iPad/],
	["Android", /Android/],
	["ChromeOS", /CrOS/],
	["Windows", /Windows/],
	["macOS", /Mac OS X|Macintosh/],
	["Linux", /Linux/],
];

/** Sessions that have not expired, latest first. */
async function sessionsOf(userId: string) {
	const rows = await sql<{ user_agent: string | null; updated_at: Date }[]>`
		select "userAgent" as user_agent, "updatedAt" as updated_at from sessions
		where "userId" = ${userId} and "expiresAt" > now() order by "updatedAt" desc`;
	return rows.map((row) => ({ device: deviceName(row.user_agent), lastUsed: row.updated_at.toISOString() }));
}

/**
 * Accounts, then invites without an account. Last active is the latest run, or else
 * the latest session.
 */
async function peopleRows(id?: string) {
	const oneUser = id ? sql`where u.id = ${id} or lower(u.email) = ${id.toLowerCase()}` : sql``;
	const oneInvite = id ? sql`and a.email = ${id.toLowerCase()}` : sql``;
	return sql<Row[]>`
		select u.id, u.name, u.email, u.role, u.banned, u."banReason" as ban_reason, u."banExpires" as ban_expires,
			u."createdAt" as joined_at, a.note, a.created_at as invited_at,
			coalesce(nullif(inviter.name, ''), split_part(inviter.email, '@', 1)) as inviter, null::int as invite_credits,
			coalesce((select max(r.created_at) from runs r where r."user" = u.id),
				(select max(s."updatedAt") from sessions s where s."userId" = u.id)) as last_active
		from users u
		left join allowed_emails a on a.email = lower(u.email)
		left join users inviter on inviter.id = a.invited_by
		${oneUser}
		union all
		select null, null, a.email, null, null, null, null, null, a.note, a.created_at,
			coalesce(nullif(inviter.name, ''), split_part(inviter.email, '@', 1)), a.daily_credits, null
		from allowed_emails a
		left join users inviter on inviter.id = a.invited_by
		where not exists (select 1 from users u where lower(u.email) = a.email) ${oneInvite}`;
}

function toPerson(row: Row, usage: Usage, limits: Awaited<ReturnType<typeof limitsToday>>): Person {
	const banned = Boolean(row.banned) && (!row.ban_expires || row.ban_expires > new Date());
	const user = row.id ?? "";
	return {
		id: row.id ?? row.email,
		name: displayName(row.name, row.email),
		email: row.email,
		role: (row.role ?? "").split(",").some((role) => role.trim() === "admin") ? "admin" : "user",
		status: !row.id ? "invited" : banned ? "banned" : "active",
		note: row.note ?? "",
		invitedAt: row.invited_at?.toISOString() ?? null,
		invitedBy: row.inviter,
		joinedAt: row.joined_at?.toISOString() ?? null,
		lastActive: row.last_active?.toISOString() ?? null,
		dailyCredits: row.id ? limits.own(user) : row.invite_credits,
		banReason: banned ? row.ban_reason : null,
		banExpires: banned ? (row.ban_expires?.toISOString() ?? null) : null,
		today: {
			used: usage.day(user).credits,
			limit: row.id ? limits.limit(user) : (row.invite_credits ?? limits.defaultDailyCredits),
			extra: row.id ? limits.extra(user) : 0,
		},
		week: usage.total(user, 7).credits,
	};
}
