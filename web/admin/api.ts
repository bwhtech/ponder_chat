/**
 * The admin API (server/admin/routes.ts), and the shapes it answers with. Usage numbers
 * only: the API never returns chats.
 */
export type Status = "active" | "invited" | "banned";

export type Settings = {
	defaultDailyCredits: number;
	creditsPerUsd: number;
	/** Models that can't read PDFs get the text the server read from them; off, OpenRouter parses each PDF. */
	pdfTextOnServer: boolean;
};

/** The OpenRouter key in use, without the key itself (server/openrouter-key.ts). */
export type KeyStatus = {
	source: "settings" | "environment" | "none";
	/** The key's last characters, such as "…3f9a". */
	hint: string | null;
	/** The saved key can't be decrypted, because BETTER_AUTH_SECRET changed. */
	unreadable: boolean;
	updatedAt: string | null;
	updatedBy: string | null;
};

export type Admin = { id: string; name: string; email: string };

export type SettingsData = Settings & { admins: Admin[]; openRouterKey: KeyStatus };

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
	/** null means the default from settings. */
	dailyCredits: number | null;
	banReason: string | null;
	banExpires: string | null;
	/** `limit` includes `extra`, the credits admins gave for today. */
	today: { used: number; limit: number; extra: number };
	/** Credits over the last 7 days. */
	week: number;
};

export type Day = { date: string; credits: number; replies: number };
export type ModelShare = { model: string; credits: number };
export type Session = { device: string; lastUsed: string };

export type PersonDetail = { person: Person; days: Day[]; models: ModelShare[]; sessions: Session[]; chats: number; settings: Settings };

export type Overview = {
	today: { active: number; replies: number; credits: number; outOfCredits: number };
	yesterday: { active: number; replies: number };
	days: (Day & { active: number })[];
	byModel: ModelShare[];
	people: { id: string; name: string; today: { used: number; limit: number }; credits: number; replies: number; activeDays: number }[];
	pendingRequests: number;
	creditsPerUsd: number;
};

type Named = { id: string; name: string; email: string };

export type PendingRequest = { id: number; createdAt: string; person: Named; today: { used: number; limit: number }; dailyLimit: number; week: number };
export type DecidedRequest = {
	id: number;
	createdAt: string;
	status: "approved" | "declined";
	credits: number | null;
	decidedAt: string;
	person: Named;
	decidedBy: string;
};

/** A skill in the list (server/skills.ts). The file holds the name, the description and `automatic`. */
export type SkillSummary = {
	id: number;
	name: string;
	description: string;
	/** Ponder can load it on its own. False: only when someone types $name. */
	automatic: boolean;
	enabled: boolean;
	updatedAt: string;
	updatedBy: string | null;
};

export type SkillDetail = SkillSummary & { source: string };

export type Viewer = { user: { id: string; email: string; name: string; role: "admin" | "user" } };

/** Calls /api/admin/<path>. Throws the server's message, which the pages show in a toast or a dialog. */
export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
	const response = await fetch(`/api/admin${path}`, {
		method: options.method ?? (options.body === undefined ? "GET" : "POST"),
		headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new ApiError(data.error ?? `Something went wrong (${response.status}).`, response.status, data.errors);
	return data as T;
}

/** The server's message, with its HTTP status, so a page can tell "not found" from a failure. */
export class ApiError extends Error {
	readonly status: number;
	/** The problems behind a refusal, one per line, when the server lists them (a skill file). */
	readonly errors: string[];
	constructor(message: string, status: number, errors: unknown = []) {
		super(message);
		this.status = status;
		this.errors = Array.isArray(errors) ? errors.map(String) : [];
	}
}

/** Who opened /admin. null when signed out (401 or 403). Throws when the server can't be reached or fails. */
export async function loadViewer(): Promise<Viewer | null> {
	const response = await fetch("/api/me");
	if (response.status === 401 || response.status === 403) return null;
	if (!response.ok) throw new Error(`The server answered ${response.status}.`);
	return response.json();
}
