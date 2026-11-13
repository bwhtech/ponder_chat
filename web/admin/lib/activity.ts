import { skillTitle } from "../../../shared/skill-file";
import type { Activity } from "../api";
import { credits, date } from "./format";

/**
 * An event of the admin activity log in plain words, for the Activity page: what the
 * admin did, and the details below it, such as "a@example.com → b@example.com".
 */
export type Described = { text: string; details: string[] };

type Fields = Record<string, unknown>;

export function describe(event: Activity): Described {
	const before = event.before ?? {};
	const after = event.after ?? {};
	const describer = DESCRIBERS[event.action];
	// The server could not find the person (admin-auth-events.ts): say so, not "no change".
	if (after.targetNotFound) return { text: skillTitle(event.action), details: ["The server could not tell who this was"] };
	// An action with no words here yet, such as "stop-impersonating", reads "Stop impersonating".
	return describer ? describer(before, after) : { text: skillTitle(event.action), details: [] };
}

const DESCRIBERS: Record<string, (before: Fields, after: Fields) => Described> = {
	"update-user": (before, after) => ({ text: updateText(before, after), details: userChanges(before, after) }),
	"set-role": (before, after) => ({ text: roleText(before, after), details: [] }),
	"ban-user": (_, after) => ({ text: "Banned", details: banDetails(after) }),
	"unban-user": () => ({ text: "Unbanned", details: [] }),
	"revoke-user-sessions": () => ({ text: "Signed them out everywhere", details: [] }),
	"revoke-user-session": () => ({ text: "Signed them out of one device", details: [] }),
	"set-daily-credits": (before, after) => ({
		text: "Set the daily credits",
		details: [`${limit(before.dailyCredits)} → ${limit(after.dailyCredits)}`],
	}),
	"grant-credits": (_, after) => ({ text: "Gave extra credits for today", details: [`+${credits(Number(after.credits))}`] }),
	"approve-request": (_, after) => ({ text: "Approved a request for credits", details: [`+${credits(Number(after.credits))}`] }),
	"decline-request": () => ({ text: "Declined a request for credits", details: [] }),
	invite: (_, after) => ({
		text: "Invited",
		details: [after.note ? `Note: ${after.note}` : "", after.dailyCredits == null ? "" : `Daily credits: ${credits(Number(after.dailyCredits))}`, after.emailed ? "Emailed the invite" : ""].filter(Boolean),
	}),
	"send-invite": () => ({ text: "Emailed the invite again", details: [] }),
	"remove-invite": () => ({ text: "Cancelled the invite", details: [] }),
	"update-settings": (before, after) => ({
		text: "Changed the credit settings",
		details: [
			changed("Default daily credits", before.defaultDailyCredits, after.defaultDailyCredits),
			changed("Credits per US dollar", before.creditsPerUsd, after.creditsPerUsd),
		].filter(Boolean),
	}),
	"set-pdf-reading": (_, after) => ({
		text: "Changed how PDFs are read",
		details: [after.pdfTextOnServer ? "Ponder reads the text" : "OpenRouter reads each PDF"],
	}),
	"set-compaction-model": (before, after) => ({
		text: "Changed the summary model",
		details: [`${before.compactionModel} → ${after.compactionModel}`],
	}),
	"set-openrouter-key": () => ({ text: "Changed the OpenRouter key", details: [] }),
	"create-skill": (_, after) => ({ text: `Created the skill ${skillName(after)}`, details: [] }),
	"update-skill": (before, after) => ({ text: `Edited the skill ${skillName(after)}`, details: skillChanges(before, after) }),
	"enable-skill": (_, after) => ({ text: `Turned on the skill ${skillName(after)}`, details: [] }),
	"disable-skill": (_, after) => ({ text: `Turned off the skill ${skillName(after)}`, details: [] }),
	"delete-skill": (before) => ({ text: `Deleted the skill ${skillName(before)}`, details: [] }),
};

function updateText(before: Fields, after: Fields) {
	const what = [before.email !== after.email && "the email", before.name !== after.name && "the name"].filter(Boolean);
	return what.length ? `Changed ${what.join(" and ")}` : "Changed the account";
}

const USER_FIELDS: [string, string][] = [
	["email", "Email"],
	["name", "Name"],
	["role", "Role"],
	["banned", "Banned"],
	["banReason", "Ban reason"],
	["banExpires", "Banned until"],
	["emailVerified", "Email verified"],
	["image", "Picture"],
];

function userChanges(before: Fields, after: Fields) {
	return USER_FIELDS.map(([field, label]) => changed(label, before[field], after[field])).filter(Boolean);
}

function banDetails(after: Fields) {
	const reason = after.banReason && after.banReason !== "No reason" ? `Reason: ${after.banReason}` : "";
	const until = typeof after.banExpires === "string" ? `Until ${date(after.banExpires)}` : "";
	return [reason, until].filter(Boolean);
}

function skillChanges(before: Fields, after: Fields) {
	return [
		changed("Name", before.name, after.name),
		before.description !== after.description ? "New description" : "",
		changed("Automatic", before.automatic, after.automatic),
		changed("On", before.enabled, after.enabled),
		after.instructionsChanged ? "New instructions" : "",
	].filter(Boolean);
}

/** "Label: old → new", or "" when the value did not change. */
function changed(label: string, before: unknown, after: unknown) {
	return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? "" : `${label}: ${value(before)} → ${value(after)}`;
}

function value(raw: unknown) {
	if (raw === null || raw === undefined || raw === "") return "—";
	if (typeof raw === "boolean") return raw ? "Yes" : "No";
	if (typeof raw === "number") return credits(raw);
	return String(raw);
}

function limit(raw: unknown) {
	return raw === null || raw === undefined ? "Default" : credits(Number(raw));
}

/** An older event of a role set to what it was has no role at all. */
function roleText(before: Fields, after: Fields) {
	if (!("role" in after)) return "Set the role, no change";
	const admin = isAdminRole(after.role);
	if ("role" in before && isAdminRole(before.role) === admin) return admin ? "Set the role to admin, no change" : "Set the role to user, no change";
	return admin ? "Made them an admin" : "Removed the admin role";
}

function isAdminRole(role: unknown) {
	return String(role ?? "").split(",").some((part) => part.trim() === "admin");
}

function skillName(fields: Fields) {
	return `“${skillTitle(String(fields.name ?? ""))}”`;
}
