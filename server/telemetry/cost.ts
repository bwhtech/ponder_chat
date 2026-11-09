/**
 * What one model call cost in US dollars, as OpenRouter reports it: in the provider
 * metadata, or in the raw usage. Credits are charged from it. No Node imports, so the
 * chat workflow can use it too (workflow/chat.ts).
 */
export function callCost(step: { providerMetadata?: Record<string, unknown>; usage: { raw?: unknown } }): number | null {
	const metadata = step.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
	const raw = step.usage.raw as { cost?: number } | undefined;
	return metadata?.usage?.cost ?? raw?.cost ?? null;
}
