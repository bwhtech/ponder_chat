import type { UIMessage } from "ai";
import { toolName, type ToolPart } from "../tool-renderers";
import { toolPhase } from "./tool-state";

type Part = UIMessage["parts"][number];

/** A run of steps: one step on its own, or two or more folded under one summary line. */
export type WorkItem = { kind: "one"; part: Part } | { kind: "fold"; parts: Part[] };

const MIN_FOLD = 2;

export function isTool(part: Part): part is ToolPart {
	return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

export function isStep(part: Part) {
	return part.type === "reasoning" || isTool(part);
}

/** A call that waits on the person: an approval card, never folded away. */
export function needsAnswer(part: Part): part is Extract<ToolPart, { state: "approval-requested" }> {
	return isTool(part) && part.state === "approval-requested" && !part.approval.isAutomatic;
}

/**
 * Folds runs of plain steps (reasoning and tool lines) so a reply reads as its text and
 * cards, not a wall of tool calls. An app's own tool drawings (`custom`) and calls that
 * wait on the person stay outside a fold, so nothing to answer is ever hidden.
 */
export function foldSteps(parts: Part[], custom: Set<string>): WorkItem[] {
	const items: WorkItem[] = [];
	let run: Part[] = [];
	const flush = () => {
		if (run.length >= MIN_FOLD) items.push({ kind: "fold", parts: run });
		else items.push(...run.map((part) => ({ kind: "one" as const, part })));
		run = [];
	};
	for (const part of parts) {
		if (isFoldable(part, custom)) run.push(part);
		else {
			flush();
			items.push({ kind: "one", part });
		}
	}
	flush();
	return items;
}

function isFoldable(part: Part, custom: Set<string>) {
	if (part.type === "reasoning") return true;
	if (!isTool(part)) return false;
	return !custom.has(toolName(part)) && !needsAnswer(part);
}

/** "Looked up 4 things and made 2 changes", and how many steps failed. */
export function summarizeSteps(parts: Part[], streaming: boolean) {
	const tools = parts.filter(isTool);
	const counts = { read: 0, write: 0, other: 0 };
	const phases = tools.map((tool) => toolPhase(tool, { streaming }));
	// A call the person denied did nothing, so it is not counted as a change.
	const denied = phases.filter((phase) => phase === "denied").length;
	tools.forEach((tool, index) => {
		if (phases[index] !== "denied") counts[actionOf(toolName(tool))]++;
	});
	const labels = [
		counts.read && `looked up ${plural(counts.read, "thing")}`,
		counts.write && `made ${plural(counts.write, "change")}`,
		counts.other && `took ${plural(counts.other, "other step")}`,
		denied && `skipped ${plural(denied, "denied step")}`,
	].filter(Boolean) as string[];
	if (!tools.length) labels.push(parts.length === 1 ? "thought" : `thought (×${parts.length})`);

	const failed = phases.filter((phase) => phase === "failed" || phase === "stopped").length;
	return { summary: capitalize(joinLabels(labels)), failed };
}

function actionOf(name: string): "read" | "write" | "other" {
	if (/delete|remove|create|insert|add|new|update|edit|set|rename|patch|save|put|submit|cancel/.test(name)) return "write";
	if (/search|find|query|lookup|get|read|list|fetch|load|schema|count|recall/.test(name)) return "read";
	return "other";
}

function plural(count: number, noun: string) {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function joinLabels(labels: string[]) {
	return labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function capitalize(text: string) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
