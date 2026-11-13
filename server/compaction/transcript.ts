import type { UIMessage } from "ai";
import { estimateTokens } from "./tokens.ts";

/**
 * The chat as plain text for the summarizer, adapted from eve's compaction prompt.ts.
 * Text goes word for word, and reasoning is left out. Tool calls and results are cut
 * in the middle to 2,000 characters, so large outputs reach the summarizer as findings
 * to keep, not as text to copy. A file is named, never sent as base64. Artifact
 * content is left out: the summary message carries the latest versions (summary.ts).
 *
 * Each message sits in a <msg-NONCE role="…"> tag, with a random nonce for each call, so
 * text in a message can't open a message of its own: a page or a connector's result
 * can't pass as the person. Tool payloads are JSON, so their line breaks stay escaped.
 */
export const PAYLOAD_CHARS = 2_000;
/** When the transcript is over its budget, older text is cut to this... */
const DEGRADED_TEXT_CHARS = 2_000;
/** ...and older tool payloads to this. */
const DEGRADED_PAYLOAD_CHARS = 280;
const SLACK_CHARS = 64;

type Part = UIMessage["parts"][number];
type Entry = { role: string; text: string };

/** The transcript of `messages`, cut oldest first to fit `budgetTokens`. `nonce` names the message tags. */
export function renderTranscript(messages: UIMessage[], budgetTokens: number, nonce: string): string {
	const entries = messages.map((message) => ({ role: message.role, text: renderMessage(message, PAYLOAD_CHARS) }));
	let excess = estimateTokens(join(entries, nonce)) - budgetTokens;
	for (let i = 0; i < entries.length && excess > 0; i++) {
		const before = entries[i].text.length;
		const limit = Math.max(DEGRADED_TEXT_CHARS, before - Math.ceil(excess * 4) - SLACK_CHARS);
		entries[i] = { ...entries[i], text: capText(renderMessage(messages[i], DEGRADED_PAYLOAD_CHARS), limit) };
		excess -= Math.max(0, Math.floor((before - entries[i].text.length) / 4));
	}
	return join(entries, nonce);
}

function join(entries: Entry[], nonce: string) {
	const text = entries
		.filter((entry) => entry.text.trim())
		.map((entry) => `<msg-${nonce} role="${entry.role}">\n${entry.text.trim()}\n</msg-${nonce}>`)
		.join("\n\n");
	return text || "(empty)";
}

function renderMessage(message: UIMessage, payloadChars: number) {
	return message.parts
		.map((part) => renderPart(part, payloadChars))
		.filter(Boolean)
		.join("\n");
}

function renderPart(part: Part, payloadChars: number): string {
	if (part.type === "text") return part.text;
	if (part.type === "file") return `Attached file "${part.filename ?? "file"}" (${part.mediaType})`;
	if (part.type === "data-skill") return `[Chose the skill ${String((part.data as { name?: unknown })?.name ?? "")}]`;
	if (part.type === "data-citation") return renderCitation(part.data, payloadChars);
	const tool = toolOf(part);
	return tool ? renderTool(tool, payloadChars) : "";
}

type ToolPart = { name: string; input: unknown; output: unknown; errorText: unknown; state?: unknown };

/** A static (`tool-<name>`) or dynamic tool part, else undefined. */
export function toolOf(part: Part): ToolPart | undefined {
	const raw = part as { type: string; toolName?: string; input?: unknown; output?: unknown; errorText?: unknown; state?: unknown };
	const name = raw.type === "dynamic-tool" ? raw.toolName : raw.type.startsWith("tool-") ? raw.type.slice(5) : undefined;
	return name ? { name, input: raw.input, output: raw.output, errorText: raw.errorText, state: raw.state } : undefined;
}

function renderTool({ name, input, output, errorText, state }: ToolPart, payloadChars: number) {
	if (name === "write_artifact") {
		const { id, kind, title } = (input ?? {}) as { id?: string; kind?: string; title?: string };
		return `Wrote artifact ${id} (${kind}): ${title}`;
	}
	const lines = [`Called ${name} with ${clipMiddle(payload(input), payloadChars)}`];
	// The error is a tool's or a server's text too: encoded, so it can't start a line of its own.
	if (typeof errorText === "string") lines.push(`Tool ${name} errored: ${clipMiddle(payload(errorText), payloadChars)}`);
	else if (output !== undefined) lines.push(`Tool ${name} returned: ${clipMiddle(payload(output), payloadChars)}`);
	// A call with no result did not run: the summary must not record it as done.
	else lines.push(NOT_RUN[String(state)] ?? "The call did not finish, so it did not run.");
	return lines.join("\n");
}

const NOT_RUN: Record<string, string> = {
	"output-denied": "The person refused this call, so it did not run.",
	"approval-requested": "The call waited for the person's approval, and did not run.",
};

function renderCitation(data: unknown, chars: number) {
	const { text, comment } = (data ?? {}) as { text?: unknown; comment?: unknown };
	if (typeof text !== "string") return "";
	const quote = `[Quoted from an earlier reply: ${clipMiddle(JSON.stringify(text), chars)}]`;
	return typeof comment === "string" && comment.trim() ? `${quote}\n${comment}` : quote;
}

/** A tool's input or output as compact JSON: a string's line breaks stay escaped, so it can't start a line of its own. */
function payload(value: unknown) {
	return typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "").replace(/\s+/g, " ");
}

/** The start and end of `text`, cut in the middle to `max` characters, without splitting a surrogate pair. */
export function clipMiddle(text: string, max: number) {
	if (text.length <= max) return text;
	const marker = ` … [${text.length - max} characters left out] … `;
	const room = Math.max(0, max - marker.length);
	const head = safeEnd(text, Math.ceil(room * 0.6));
	const tail = safeStart(text, text.length - (room - head));
	return text.slice(0, head) + marker + text.slice(tail);
}

/** The start of `text`, cut to `max` characters with "…". */
function capText(text: string, max: number) {
	const flat = text.replace(/\s+/g, " ");
	return flat.length <= max ? flat : `${flat.slice(0, safeEnd(flat, max - 1))}…`;
}

/** An end index that does not fall inside a surrogate pair. */
function safeEnd(text: string, index: number) {
	const code = text.charCodeAt(index - 1);
	return code >= 0xd800 && code < 0xdc00 ? index - 1 : index;
}

/** A start index that does not fall inside a surrogate pair. */
function safeStart(text: string, index: number) {
	const code = text.charCodeAt(index);
	return code >= 0xdc00 && code < 0xe000 ? index + 1 : index;
}
