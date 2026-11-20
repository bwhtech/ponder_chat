import { displayName } from "../../shared/display-name.ts";
import * as Schema from "effect/Schema";
import { roleFrom } from "../people/Accounts.ts";
import type { Limits, Usage } from "./usage.ts";

/**
 * People for /admin: everyone with an account (Better Auth's `users`), and everyone
 * invited who has not signed in yet (`allowed_emails`). An invited person's id is their
 * email, since they have no account yet. Only usage numbers, never chats.
 *
 * Plain code: AdminReports.ts reads the rows.
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
	/** They have signed in with Microsoft, so a Microsoft account is linked (auth/microsoft.ts). */
	microsoft: boolean;
};

/** An account or an invite, as AdminReports.ts reads it: text, boolean, ::int, timestamptz as a Date. */
export const PersonRow = Schema.Struct({
	id: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	email: Schema.String,
	role: Schema.NullOr(Schema.String),
	banned: Schema.NullOr(Schema.Boolean),
	ban_reason: Schema.NullOr(Schema.String),
	ban_expires: Schema.NullOr(Schema.Date),
	joined_at: Schema.NullOr(Schema.Date),
	note: Schema.NullOr(Schema.String),
	invited_at: Schema.NullOr(Schema.Date),
	inviter: Schema.NullOr(Schema.String),
	invite_credits: Schema.NullOr(Schema.Number),
	last_active: Schema.NullOr(Schema.Date),
	microsoft: Schema.Boolean,
});
type PersonRow = typeof PersonRow.Type;

/** A person at `now`: a ban that has expired is no ban. */
export function toPerson(row: PersonRow, usage: Usage, limits: Limits, now: Date): Person {
	const banned = Boolean(row.banned) && (!row.ban_expires || row.ban_expires > now);
	const user = row.id ?? "";
	return {
		id: row.id ?? row.email,
		name: displayName(row.name, row.email),
		email: row.email,
		role: roleFrom(row.role),
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
		microsoft: row.microsoft,
	};
}

/** "Chrome on macOS", from a session's user agent. */
export function deviceName(userAgent: string | null) {
	const agent = userAgent ?? "";
	const browser = BROWSERS.find(([, test]) => test.test(agent))?.[0] ?? "Unknown browser";
	const system = SYSTEMS.find(([, test]) => test.test(agent))?.[0];
	return system ? `${browser} on ${system}` : browser;
}

/** People have no name until they set one, so the start of the email stands in (shared/display-name.ts). */
export { displayName };

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
