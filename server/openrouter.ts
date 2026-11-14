/**
 * Privacy for every OpenRouter call: route only to Zero Data Retention endpoints, so
 * no provider keeps or trains on what people write. `zdr` is the strict rule (no
 * prompt or reply is kept); `data_collection: "deny"` also excludes any provider that
 * may store data. OpenRouter refuses the call when a model has no such endpoint.
 *
 * Not covered: OpenRouter's own tools, such as the PDF parser (workflow/model.ts).
 * OpenRouter's ZDR rule filters model endpoints only.
 */
const PRIVATE = { zdr: true, data_collection: "deny" } as const;

/**
 * Where OpenRouter's API is. OPENROUTER_BASE_URL points every call at another server,
 * such as the fake OpenRouter that the end-to-end tests run (e2e/fake/), so they need
 * no key and spend nothing.
 */
const BASE_URL = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api").replace(/\/$/, "");

/** An OpenRouter API address, such as openRouterUrl("v1/chat/completions"). */
export function openRouterUrl(path: string) {
	return `${BASE_URL}/${path}`;
}

/** The `provider` setting for @openrouter/ai-sdk-provider, whose types do not list `zdr` yet. */
export const privateRouting = PRIVATE as unknown as { data_collection: "deny" };

/** The same, for requests sent to OpenRouter's API directly. */
export const privateRoutingBody = PRIVATE;

/**
 * Providers that hold back a tool call and send it whole at the end; replies skip them.
 * Wafer sent nothing for 17 seconds while it wrote a slide deck, then all of it in 1.5
 * seconds, so the page could not show the deck as it was written. Each model on our list
 * has other private endpoints, so none is left without one.
 */
export const HELD_BACK_TOOL_CALLS = ["wafer"];

const ZDR_ENDPOINTS = openRouterUrl("v1/endpoints/zdr");
const REFRESH_MS = 60 * 60 * 1000;
type ZdrEndpoint = { model_id: string; provider_name?: string; tag?: string; context_length?: number };
let zdrModels: { ids: Set<string>; windows: Map<string, number>; at: number } | undefined;

/**
 * The models with at least one ZDR endpoint, from OpenRouter's public list, read at
 * most once an hour. Undefined when the list can't be read: the caller decides.
 */
export async function modelsWithZdr(): Promise<Set<string> | undefined> {
	return (await zdrList())?.ids;
}

/**
 * The same list, but only as far as it is known now: never waits for OpenRouter.
 * Undefined before the first read (just after a start). An old list starts a new read.
 */
export function modelsWithZdrNow(): Set<string> | undefined {
	void zdrList();
	return zdrModels?.ids;
}

/**
 * A model's context window in tokens: the smallest among its ZDR endpoints that replies
 * use, since OpenRouter may route a call to any of them. Undefined when it is not known.
 */
export async function contextWindow(modelId: string): Promise<number | undefined> {
	return (await zdrList())?.windows.get(modelId);
}

let reading: Promise<typeof zdrModels> | undefined;

/**
 * The list, read again once it is an hour old. Until the new read ends, the old list
 * answers: only the first request after a start waits for OpenRouter (GET /api/models
 * took 160 ms at the median when each hour's first request waited). One read at a time.
 */
async function zdrList() {
	if (zdrModels && Date.now() - zdrModels.at < REFRESH_MS) return zdrModels;
	reading ??= readZdrList().finally(() => (reading = undefined));
	return zdrModels ?? reading;
}

async function readZdrList() {
	try {
		const response = await fetch(ZDR_ENDPOINTS, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const endpoints = ((await response.json()) as { data?: ZdrEndpoint[] }).data ?? [];
		zdrModels = { ids: new Set(endpoints.map((endpoint) => endpoint.model_id)), windows: smallestWindows(endpoints), at: Date.now() };
		return zdrModels;
	} catch (error) {
		console.warn("OpenRouter ZDR list:", error instanceof Error ? error.message : error);
		return zdrModels;
	}
}

function smallestWindows(endpoints: ZdrEndpoint[]) {
	const windows = new Map<string, number>();
	for (const endpoint of endpoints) {
		if (!(endpoint.context_length && endpoint.context_length > 0) || heldBack(endpoint)) continue;
		const known = windows.get(endpoint.model_id);
		windows.set(endpoint.model_id, known ? Math.min(known, endpoint.context_length) : endpoint.context_length);
	}
	return windows;
}

function heldBack(endpoint: ZdrEndpoint) {
	const names = [endpoint.provider_name, endpoint.tag?.split("/")[0]].map((name) => name?.toLowerCase());
	return HELD_BACK_TOOL_CALLS.some((slug) => names.includes(slug));
}
