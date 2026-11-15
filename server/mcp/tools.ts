import { createHash } from "node:crypto";
import type { Connection, Rule, ToolInfo } from "./ConnectorStore.ts";

/**
 * Connector tools as the model sees them: their names, the rule that says whether a call
 * needs the person's approval, and their results as text.
 */

/**
 * A tool's name for the model: "<slug>__<tool>", such as linear__create_issue. Two
 * servers can have tools with the same name, so the slug keeps them apart. Most
 * providers allow 64 characters of a-z, A-Z, 0-9, _ and -; a longer name is cut and
 * ends with a hash of the whole, so it stays unique.
 */
export function modelToolName(slug: string, tool: string) {
	const name = `${slug}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
	if (name.length <= 64) return name;
	const hash = createHash("sha256").update(`${slug}__${tool}`).digest("hex").slice(0, 6);
	return `${name.slice(0, 57)}_${hash}`;
}

/** A short slug from the connector's name, not one the person has already: "linear", "linear_2". */
export function slugFor(name: string, taken: Set<string>) {
	const base =
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 20)
			.replace(/_+$/, "") || "mcp";
	let slug = base;
	for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
	return slug;
}

/** A tool that says it only reads starts as "Always allow"; every other tool starts as "Ask first". */
export const defaultRule = (tool: ToolInfo): Rule => (tool.readOnly ? "allow" : "ask");

export const ruleOf = (connection: Pick<Connection, "toolRules">, tool: ToolInfo): Rule => connection.toolRules[tool.name] ?? defaultRule(tool);

const MAX_SCHEMA_CHARS = 20_000;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;

type ListedTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
};

/** A listed tool as plain data. A schema too large to send on every call is replaced by an open object. */
export function toToolInfo(tool: ListedTool): ToolInfo {
	const schema = JSON.stringify(tool.inputSchema ?? {}).length > MAX_SCHEMA_CHARS ? { type: "object" } : tool.inputSchema;
	return {
		name: tool.name,
		title: (tool.title ?? tool.annotations?.title)?.slice(0, MAX_TITLE_CHARS),
		description: tool.description?.slice(0, MAX_DESCRIPTION_CHARS),
		inputSchema: { type: "object", ...schema },
		readOnly: tool.annotations?.readOnlyHint === true,
		destructive: tool.annotations?.destructiveHint !== false && tool.annotations?.readOnlyHint !== true,
	};
}

/** At most this much of a result goes to the model. context.ts trims it again in later turns. */
export const MAX_RESULT_CHARS = 50_000;

type Content =
	| { type: "text"; text: string }
	| { type: "image" | "audio"; mimeType?: string }
	| { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
	| { type: "resource_link"; uri: string; name?: string }
	| { type: string };

type CallResult = { content?: Content[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };

/** What the model reads of a tool's result: its text, with images and files named. */
export function resultText(result: CallResult): { text: string; isError: boolean } {
	const parts: string[] = [];
	for (const item of result.content ?? []) {
		if (item.type === "text" && "text" in item) parts.push(item.text);
		else if ((item.type === "image" || item.type === "audio") && "mimeType" in item) parts.push(`[${item.type} (${item.mimeType ?? "unknown type"}) left out: Ponder can't show it yet]`);
		else if (item.type === "resource" && "resource" in item) parts.push(item.resource.text ?? `[file ${item.resource.uri} left out]`);
		else if (item.type === "resource_link" && "uri" in item) parts.push(`[link: ${item.name ?? item.uri} ${item.uri}]`);
	}
	if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
	if (!parts.length && result.toolResult !== undefined) parts.push(JSON.stringify(result.toolResult));
	const text = parts.join("\n\n") || "(The tool returned nothing.)";
	const capped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut: the result had ${text.length} characters. Ask for less, such as with a filter or a smaller page.]` : text;
	return { text: capped, isError: result.isError === true };
}
