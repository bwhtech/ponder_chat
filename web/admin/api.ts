import { client, type Answer } from "../api";

export { ApiError, unwrap } from "../api";

/**
 * The admin API (server/admin/routes.ts), and the shapes it answers with, as the typed
 * client reads them from the routes. Usage numbers only: the API never returns chats.
 * The pages read each answer with unwrap(), which throws the server's message for a toast
 * or a dialog.
 */
export const admin = client.api.admin;

export type SettingsData = Answer<typeof admin.settings.$get>;
export type Settings = Answer<typeof admin.settings.$put>;
/** The OpenRouter key in use, without the key itself (server/openrouter/OpenRouterKey.ts). */
export type KeyStatus = SettingsData["openRouterKey"];
export type Admin = SettingsData["admins"][number];

export type Person = Answer<typeof admin.people.$get>["people"][number];
export type PersonDetail = Answer<(typeof admin.people)[":id"]["$get"]>;

// Written out, not read from the routes. Where a page keeps an answer in one of them, the
// typecheck confirms that the answer fits.
export type Status = "active" | "invited" | "banned";
export type Day = { date: string; credits: number; replies: number };
export type ModelShare = { model: string; credits: number };
export type Overview = {
	today: { active: number; replies: number; credits: number; outOfCredits: number };
	yesterday: { active: number; replies: number };
	days: (Day & { active: number })[];
	byModel: ModelShare[];
	/** The app's own calls, in US dollars: no one's credits (server/admin/usage.ts). */
	system: SystemSpend;
	people: { id: string; name: string; today: { used: number; limit: number }; credits: number; replies: number; activeDays: number }[];
	pendingRequests: number;
	creditsPerUsd: number;
};

export type SystemSpend = { usd: number; calls: number; byFunction: { functionId: string; usd: number; calls: number }[] };

/** GET /api/admin/workspaces (server/workspaces/admin.ts): organisation workspaces in full, private ones as totals. */
export type DocumentStatus = "reading" | "ready" | "failed";
/** How far an Indexing document is: the same as a workspace's (web/workspaces/documents.ts). */
export type DocumentProgress = { phase: "pages" | "embedding"; done: number; total: number };
export type OrgDocument = {
	id: string;
	name: string;
	mediaType: string;
	size: number;
	status: DocumentStatus;
	error: string | null;
	createdAt: string;
	progress: DocumentProgress | null;
	costUsd: number | null;
};
export type OrgWorkspace = {
	id: string;
	slug: string;
	name: string;
	description: string;
	icon: string | null;
	owner: { id: string; name: string; email: string };
	createdAt: string;
	updatedAt: string;
	documents: OrgDocument[];
	costUsd: number | null;
};
export type PrivateWorkspaces = { workspaces: number; documents: Record<DocumentStatus, number>; costUsd: number; errors: { error: string; documents: number }[] };
export type WorkspacesReport = { org: OrgWorkspace[]; private: PrivateWorkspaces };

type Requests = Answer<typeof admin.requests.$get>;
export type PendingRequest = Requests["pending"][number];
export type DecidedRequest = Requests["decided"][number];

/** A page of the log (server/admin/activity.ts). */
export type ActivityPage = Answer<typeof admin.activity.$get>;
export type Activity = ActivityPage["events"][number];

export type SkillSummary = Answer<typeof admin.skills.$get>["skills"][number];
export type SkillDetail = Answer<(typeof admin.skills)[":id"]["$get"]>;

export type Viewer = Answer<typeof client.api.me.$get>;

/** Who opened /admin. null when signed out (401 or 403). Throws when the server can't be reached or fails. */
export async function loadViewer(): Promise<Viewer | null> {
	const response = await client.api.me.$get();
	// The route's type has only its 200: the 401 comes from the session check before it.
	if ([401, 403].includes(response.status)) return null;
	if (!response.ok) throw new Error(`The server answered ${response.status}.`);
	return response.json();
}
