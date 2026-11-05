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

/** The `provider` setting for @openrouter/ai-sdk-provider, whose types do not list `zdr` yet. */
export const privateRouting = PRIVATE as unknown as { data_collection: "deny" };

/** The same, for requests sent to OpenRouter's API directly. */
export const privateRoutingBody = PRIVATE;

const ZDR_ENDPOINTS = "https://openrouter.ai/api/v1/endpoints/zdr";
const REFRESH_MS = 60 * 60 * 1000;
let zdrModels: { ids: Set<string>; at: number } | undefined;

/**
 * The models with at least one ZDR endpoint, from OpenRouter's public list, read at
 * most once an hour. Undefined when the list can't be read: the caller decides.
 */
export async function modelsWithZdr(): Promise<Set<string> | undefined> {
	if (zdrModels && Date.now() - zdrModels.at < REFRESH_MS) return zdrModels.ids;
	try {
		const response = await fetch(ZDR_ENDPOINTS, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as { data?: { model_id: string }[] };
		zdrModels = { ids: new Set((body.data ?? []).map((endpoint) => endpoint.model_id)), at: Date.now() };
		return zdrModels.ids;
	} catch (error) {
		console.warn("OpenRouter ZDR list:", error instanceof Error ? error.message : error);
		return zdrModels?.ids;
	}
}
