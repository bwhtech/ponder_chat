import type { ChatToolCallItem } from "@astryxdesign/core/Chat";
import type { ToolPart } from "../tool-renderers";

/**
 * Where a tool call stands, from its part state alone. Every part state maps here, so none
 * falls into a wrong default. `approved` is a call the person allowed that has not run
 * yet: with two approvals in one message the stream waits until both are answered.
 */
export type ToolPhase = "preparing" | "running" | "needs-approval" | "approved" | "denied" | "stopped" | "failed" | "done";

export type ToolStateContext = {
	/** The chat is still streaming this message. A running tool after the stream stops has failed. */
	streaming?: boolean;
	/** For output-available: the output itself reports a failure, such as `{ ok: false }`. */
	failed?: boolean;
};

export function toolPhase(part: ToolPart, context: ToolStateContext = {}): ToolPhase {
	const streaming = context.streaming ?? true;
	switch (part.state) {
		case "input-streaming":
			return streaming ? "preparing" : "stopped";
		case "input-available":
			return streaming ? "running" : "stopped";
		case "approval-requested":
			return "needs-approval";
		case "approval-responded":
			if (part.approval?.approved === false) return "denied";
			return streaming ? "running" : "approved";
		case "output-available":
			if (context.failed ?? outputFailed(part)) return "failed";
			if (part.preliminary) return streaming ? "running" : "stopped";
			return "done";
		case "output-error":
			return "failed";
		case "output-denied":
			return "denied";
		default:
			return part satisfies never;
	}
}

/** The ChatToolCalls status for a phase. A denied or stopped call did not finish, so it reads as an error. */
export function callStatus(phase: ToolPhase): NonNullable<ChatToolCallItem["status"]> {
	if (phase === "preparing" || phase === "running") return "running";
	if (phase === "needs-approval" || phase === "approved") return "pending";
	if (phase === "done") return "complete";
	return "error";
}

/** Why a call did not finish, for the row's error tooltip. */
export function phaseError(part: ToolPart, phase: ToolPhase): string | undefined {
	if (part.state === "output-error") return part.errorText;
	if (phase === "denied") return "Denied";
	if (phase === "stopped") return "Stopped";
	if (phase === "failed") return outputError(part) ?? "Failed";
	return undefined;
}

/** A call that ran but reports a failure in its output, as web_fetch and run_python do. */
export function outputFailed(part: ToolPart) {
	if (part.state !== "output-available") return false;
	const output = part.output as { error?: unknown; ok?: unknown } | null;
	return typeof output === "object" && !!output && (!!output.error || output.ok === false);
}

function outputError(part: ToolPart) {
	const output = part.state === "output-available" ? (part.output as { error?: unknown } | null) : null;
	return typeof output?.error === "string" ? output.error : undefined;
}

export function toolTitle(phase: ToolPhase, name: string) {
	const titles: Record<ToolPhase, string> = {
		preparing: `Running ${name}`,
		running: `Running ${name}`,
		"needs-approval": `Waiting for approval to ${name}`,
		approved: `Approved ${name}, waiting to run`,
		denied: `Denied ${name}`,
		stopped: `Failed to ${name}`,
		failed: `Failed to ${name}`,
		done: `Ran ${name}`,
	};
	return titles[phase];
}

/** "get_doctype_schema" -> "get doctype schema". */
export function humanizeToolName(name: string) {
	return name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

/** Pulls readable text out of a tool output; MCP results arrive as `{ content: [{ type: "text", text }] }`. */
export function formatToolOutput(output: unknown): { code: string; language: string; isError: boolean } {
	const isError = isRecord(output) && output.isError === true;
	if (typeof output === "string") return { ...prettyText(output), isError };
	const texts = mcpTexts(output);
	if (texts) return { ...prettyText(texts), isError };
	return { code: JSON.stringify(output, null, 2) ?? "", language: "json", isError };
}

export function formatToolInput(input: unknown) {
	if (input === undefined) return "";
	return typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
}

function mcpTexts(output: unknown) {
	if (!isRecord(output) || !Array.isArray(output.content)) return null;
	const texts = output.content.filter((item) => isRecord(item) && item.type === "text").map((item) => String((item as { text?: unknown }).text));
	return texts.length ? texts.join("\n\n") : null;
}

function prettyText(text: string) {
	try {
		return { code: JSON.stringify(JSON.parse(text), null, 2), language: "json" };
	} catch {
		return { code: text, language: "plaintext" };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * A short line naming what a tool call acts on, for approval cards: the `doctype` and a
 * name-like value, looked for at the top level and in `data` / `doc`. Falls back to the
 * first two short text values. Empty when nothing fits.
 */
export function summarizeToolInput(input: unknown): string {
	if (!isRecord(input)) return "";
	const batch = docsOf(input) ?? docsOf(input.args) ?? docsOf(input.kwargs);
	if (batch?.length) {
		const types = [...new Set(batch.map((doc) => (doc as Record<string, unknown>)?.doctype).filter((type) => typeof type === "string"))];
		const what = types.length === 1 ? `${types[0]} records` : "records";
		return `${batch.length} ${batch.length === 1 ? what.replace(/s$/, "") : what}`;
	}
	const nested = [input.data, input.doc].find((value) => isRecord(value) && !Array.isArray(value)) as Record<string, unknown> | undefined;
	const scopes = [input, nested ?? {}];
	const pick = (keys: string[]) =>
		scopes.flatMap((scope) => keys.map((key) => scope[key])).find((value): value is string => typeof value === "string" && value.trim() !== "");

	const doctype = pick(["doctype", "doc_type"]);
	const name = pick(["title", "name", "full_name", "label"]) ?? firstNameLike(nested ?? input);
	const parts = [doctype, name].filter(Boolean) as string[];
	if (parts.length) return parts.join(" · ");

	return Object.values(input)
		.filter((value): value is string => typeof value === "string" && value.length <= 60)
		.slice(0, 2)
		.join(" · ");
}

/** The `docs` list of a bulk call such as frappe.client.insert_many, if this is one. */
function docsOf(value: unknown): unknown[] | undefined {
	if (!isRecord(value)) return undefined;
	return Array.isArray(value.docs) ? value.docs : undefined;
}

function firstNameLike(scope: Record<string, unknown>) {
	const key = Object.keys(scope).find((key) => /(^|_)(name|title)$/.test(key) && typeof scope[key] === "string");
	return key ? (scope[key] as string) : undefined;
}
