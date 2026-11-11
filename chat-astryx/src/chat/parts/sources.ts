import type { UIMessage } from "ai";

/**
 * The pages a reply can cite: `source-url` parts, and the outputs of tools that return
 * pages, either `{ results: [{ url, title, text }] }` (a search) or `{ url, title }`
 * (a page read). A link in the reply to one of these becomes a citation chip (Reply).
 */
export type PageSource = { url: string; title?: string; description?: string };
export type SourceIndex = Map<string, PageSource>;

const EXCERPT_CHARS = 220;

export function collectSources(message: UIMessage): SourceIndex {
	const index: SourceIndex = new Map();
	const add = (source: { url?: unknown; title?: unknown; text?: unknown }) => {
		if (typeof source.url !== "string" || !/^https?:/.test(source.url)) return;
		const key = sourceKey(source.url);
		if (!key || index.has(key)) return;
		index.set(key, { url: source.url, title: stringOrUndefined(source.title), description: excerpt(source.text) });
	};
	for (const part of message.parts) {
		if (part.type === "source-url") add(part);
		const output = toolOutput(part) as { results?: unknown; url?: unknown; error?: unknown } | undefined;
		if (!output || output.error) continue;
		if (Array.isArray(output.results)) output.results.forEach((result) => result && typeof result === "object" && add(result));
		else add(output);
	}
	return index;
}

/** The `source-url` parts of a reply, each page once, for the "Used N sources" line. */
export function sourceUrls(message: UIMessage) {
	const parts = message.parts.filter((part) => part.type === "source-url");
	return parts.filter((part, index) => parts.findIndex((other) => other.url === part.url) === index);
}

/** The same page whatever its scheme, "www.", trailing slash, fragment or tracking parameters. */
export function sourceKey(url: string) {
	try {
		const parsed = new URL(url);
		const params = parsed.search
			.slice(1)
			.split("&")
			.filter((param) => param && !/^(utm_[^=]*|ref|fbclid|gclid)(=|$)/.test(param));
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.hostname.replace(/^www\./, "")}${path}${params.length ? `?${params.join("&")}` : ""}`.toLowerCase();
	} catch {
		return "";
	}
}

export function hostname(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

function toolOutput(part: UIMessage["parts"][number]) {
	if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return undefined;
	const tool = part as { state?: string; output?: unknown };
	return tool.state === "output-available" && tool.output && typeof tool.output === "object" ? tool.output : undefined;
}

function excerpt(text: unknown) {
	if (typeof text !== "string" || !text.trim()) return undefined;
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS).replace(/\s\S*$/, "")}…` : clean;
}

function stringOrUndefined(value: unknown) {
	return typeof value === "string" && value.trim() ? value : undefined;
}
