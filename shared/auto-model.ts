/**
 * OpenRouter's Auto Router, which picks the model for each call (server/auto-router.ts).
 * Shared because the page hides the model name on its replies.
 */
export const AUTO_MODEL_ID = "openrouter/auto";

export function isAuto(modelId: unknown) {
	return modelId === AUTO_MODEL_ID;
}
