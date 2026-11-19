import { skillTitle } from "../../../shared/skill-file";
import type { Activity } from "../api";
import { count } from "../../numbers";
import { credits, date } from "./format";
import { AUTO_COST_OPTIONS } from "./settings-form";

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
	"set-auto-cost-tier": (before, after) => ({
		text: "Changed what Auto may spend",
		details: [`${tierName(before.autoCostTier)} → ${tierName(after.autoCostTier)}`],
	}),
	"set-openrouter-key": () => ({ text: "Changed the OpenRouter key", details: [] }),
	"set-logo": (_, after) => ({ text: `Changed the logo for ${themeName(after.theme)}`, details: [] }),
	"remove-logo": (before) => ({ text: `Removed the logo for ${themeName(before.theme)}`, details: [] }),
	// Sign in with Microsoft (server/auth/microsoft.ts). The server says that the secret changed, never the secret.
	"set-microsoft-sign-in": (before, after) => ({
		text: before.enabled === after.enabled ? "Changed sign-in with Microsoft" : `Turned ${after.enabled ? "on" : "off"} sign-in with Microsoft`,
		details: [
			changed("Directory (tenant) ID", before.tenantId, after.tenantId),
			changed("Application (client) ID", before.clientId, after.clientId),
			after.secretChanged ? "New client secret" : "",
			changed("Email domains", list(before.allowedDomains), list(after.allowedDomains)),
			changed("New accounts", signUpsName(before.signUps), signUpsName(after.signUps)),
			after.unlinkedEveryone ? "Unlinked everyone's Microsoft account, for the new directory" : "",
		].filter(Boolean),
	}),
	"unlink-microsoft": () => ({ text: "Unlinked their Microsoft account", details: [] }),
	"create-skill": (_, after) => ({ text: `Created the skill ${skillName(after)}`, details: [] }),
	"update-skill": (before, after) => ({ text: `Edited the skill ${skillName(after)}`, details: skillChanges(before, after) }),
	"enable-skill": (_, after) => ({ text: `Turned on the skill ${skillName(after)}`, details: [] }),
	"disable-skill": (_, after) => ({ text: `Turned off the skill ${skillName(after)}`, details: [] }),
	"delete-skill": (before) => ({ text: `Deleted the skill ${skillName(before)}`, details: [] }),
	// Workspaces open to everyone only (server/workspaces/Workspaces.ts). The server sends the instructions' length, not their text.
	"create-workspace": (_, after) => ({ text: `Made ${theWorkspace(after)}`, details: [instructionsLength(after)].filter(Boolean) }),
	"update-workspace": (before, after) => ({ text: `Edited ${theWorkspace(after)}`, details: workspaceChanges(before, after) }),
	"share-workspace": (before, after) => ({ text: sharingText(before, after), details: sharingChanges(before, after) }),
	"delete-workspace": (before) => ({ text: `Deleted ${theWorkspace(before)}`, details: [] }),
};

/** “the workspace “Handbook””, or “a workspace”: the server names a workspace only while it is open to everyone (server/admin/activity.ts). */
function theWorkspace(fields: Fields) {
	return typeof fields.name === "string" ? `the workspace “${fields.name}”` : "a workspace";
}

function workspaceChanges(before: Fields, after: Fields) {
	return [
		changed("Name", before.name, after.name),
		before.description !== after.description ? "New description" : "",
		before.icon !== after.icon ? "New icon" : "",
		after.instructionsChanged ? `New instructions, ${count(Number(before.instructionsLength ?? 0))} → ${count(Number(after.instructionsLength ?? 0))} characters` : "",
	].filter(Boolean);
}

function instructionsLength(fields: Fields) {
	const length = Number(fields.instructionsLength ?? 0);
	return length ? `Instructions: ${count(length)} characters` : "";
}

/** Opened to everyone, closed to everyone, or a change of its people. */
function sharingText(before: Fields, after: Fields) {
	const opened = (fields: Fields) => fields.orgAccess === "ask";
	if (!opened(before) && opened(after)) return `Opened ${theWorkspace(after)} to everyone`;
	if (opened(before) && !opened(after)) return `Closed ${theWorkspace(after)} to everyone`;
	return `Changed who can use ${theWorkspace(after)}`;
}

function sharingChanges(before: Fields, after: Fields) {
	const members = (fields: Fields) => (Array.isArray(fields.members) ? fields.members.length : 0);
	const general = (fields: Fields) => (fields.orgAccess === "ask" ? "Everyone (can ask)" : "Only people added");
	const roles = (fields: Fields) => JSON.stringify(fields.members ?? []);
	return [
		changed("General access", general(before), general(after)),
		members(before) === members(after) ? "" : `Members: ${count(members(before))} → ${count(members(after))}`,
		members(before) === members(after) && roles(before) !== roles(after) ? "A member's role changed" : "",
	].filter(Boolean);
}

/** The logo's theme (server/branding/Branding.ts). */
function list(values: unknown) {
	return Array.isArray(values) ? values.join(", ") : "";
}

function signUpsName(signUps: unknown) {
	return signUps === "everyone" ? "Everyone in the organisation" : "Invited people only";
}

function themeName(theme: unknown) {
	return theme === "dark" ? "dark mode" : "light mode";
}

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

function tierName(tier: unknown) {
	return AUTO_COST_OPTIONS.find((option) => option.value === tier)?.label ?? String(tier ?? "—");
}

function skillName(fields: Fields) {
	return `“${skillTitle(String(fields.name ?? ""))}”`;
}
