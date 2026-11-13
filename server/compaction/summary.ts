import type { UIMessage } from "ai";
import { SUMMARY_END, SUMMARY_PREAMBLE } from "./prompt.ts";
import { estimateTokens } from "./tokens.ts";
import { toolOf } from "./transcript.ts";

/**
 * Which messages a summary covers, and the message that stands in for them. No Node
 * imports, so the checks and the workflow can use it.
 *
 * A summary covers the first `covers` messages of the thread. The model reads one
 * person's message in their place: the summary, then what the covered part holds that a
 * later turn may need word for word. That is the files the person attached (still read
 * in full, file-context.ts), the skills they chose with $name, and the latest version of
 * each artifact, since a new version must be written whole.
 */
export type Summary = {
	text: string;
	/** How many of the thread's first messages it stands for. */
	covers: number;
	/** False when the covered files are named only, to make room. */
	keepFiles: boolean;
	/**
	 * How many of the thread's first messages the summarizer read: up to the current turn,
	 * so the kept tail too. A change to any of them makes the summary stale. The covered
	 * count when not given.
	 */
	reads?: number;
};

export const SUMMARY_MESSAGE_ID = "ponder-summary";
/** The most artifact content the summary message carries word for word. */
const ARTIFACT_TOKENS = 40_000;

type Part = UIMessage["parts"][number];
type Artifact = { id: string; kind: string; title: string; content: string };

/** The thread as the model reads it: the summary in place of the messages it covers. */
export function withSummary(thread: UIMessage[], summary: Summary | undefined): UIMessage[] {
	if (!summary || summary.covers <= 0) return thread;
	const kept = thread.slice(summary.covers);
	return [summaryMessage(thread.slice(0, summary.covers), kept, summary), ...kept];
}

export function summaryMessage(covered: UIMessage[], kept: UIMessage[], summary: Summary): UIMessage {
	const parts: Part[] = [{ type: "text", text: `${SUMMARY_PREAMBLE}\n\n${summary.text.trim()}\n${SUMMARY_END}` }];
	const artifacts = artifactsText(covered, kept);
	if (artifacts) parts.push({ type: "text", text: artifacts });
	parts.push(...chosenSkills(covered));
	parts.push(...attachedFiles(covered, summary.keepFiles));
	return { id: SUMMARY_MESSAGE_ID, role: "user", parts };
}

/** Where the current turn starts: the person's latest message, or -1. */
export function currentTurnStart(thread: UIMessage[]) {
	return thread.map((message) => message.role).lastIndexOf("user");
}

/**
 * Where the word-for-word tail starts. It holds the current turn, then whole earlier
 * turns, newest first, while they fit `tailTokens`. Turns are whole, so a tool call and
 * its result (one assistant message) are never split. Undefined when there is nothing
 * after `from` (the previous summary's end) to summarize.
 */
export function planCovers(thread: UIMessage[], from: number, tailTokens: number): number | undefined {
	const turn = currentTurnStart(thread);
	if (turn <= from) return undefined;
	let start = turn;
	let used = estimateTokens(thread.slice(turn));
	for (let at = previousUser(thread, start); at > from; at = previousUser(thread, start)) {
		const size = estimateTokens(thread.slice(at, start));
		if (used + size > tailTokens) break;
		used += size;
		start = at;
	}
	// A tail with everything since the last summary would summarize nothing new.
	return start > from ? start : turn;
}

function previousUser(thread: UIMessage[], before: number) {
	return before > 0 ? thread.map((message) => message.role).lastIndexOf("user", before - 1) : -1;
}

/** The latest version of each artifact last written in the covered part, newest first, within the budget. */
function artifactsText(covered: UIMessage[], kept: UIMessage[]) {
	const rewritten = new Set(artifactsIn(kept).map((artifact) => artifact.id));
	const latest = new Map<string, Artifact>();
	for (const artifact of artifactsIn(covered)) {
		latest.delete(artifact.id);
		latest.set(artifact.id, artifact);
	}
	const blocks: string[] = [];
	let room = ARTIFACT_TOKENS;
	for (const artifact of [...latest.values()].reverse()) {
		if (rewritten.has(artifact.id)) continue;
		const open = `<artifact id="${artifact.id}" kind="${artifact.kind}" title="${artifact.title.replace(/"/g, "&quot;")}">`;
		const block = `${open}\n${artifact.content}\n</artifact>`;
		const size = estimateTokens(block);
		if (size <= room) {
			blocks.push(block);
			room -= size;
		} else {
			blocks.push(`${open}\n[Its content is not included, to make room. Before you change it, ask the person what to keep.]\n</artifact>`);
		}
	}
	if (!blocks.length) return "";
	return `The latest version of each artifact written in the summarized messages:\n\n${blocks.join("\n\n")}`;
}

function artifactsIn(messages: UIMessage[]): Artifact[] {
	return messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			const tool = toolOf(part);
			const input = tool?.name === "write_artifact" ? (tool.input as Partial<Artifact> | undefined) : undefined;
			return input?.id && typeof input.content === "string" ? [{ id: input.id, kind: input.kind ?? "document", title: input.title ?? input.id, content: input.content }] : [];
		}),
	);
}

/** The skills the person chose with $name: one part per name, so their instructions still go in (workflow/skills.ts). */
function chosenSkills(covered: UIMessage[]): Part[] {
	const byName = new Map<string, Part>();
	for (const part of covered.filter((message) => message.role === "user").flatMap((message) => message.parts)) {
		const name = part.type === "data-skill" ? (part.data as { name?: unknown } | undefined)?.name : undefined;
		if (typeof name === "string") byName.set(name, part);
	}
	return [...byName.values()];
}

/** The files the person attached, as links that file-context.ts reads, or named only. */
function attachedFiles(covered: UIMessage[], keep: boolean): Part[] {
	const seen = new Set<string>();
	const files: Part[] = [];
	for (const part of covered.filter((message) => message.role === "user").flatMap((message) => message.parts)) {
		if (part.type !== "file" || seen.has(part.url)) continue;
		seen.add(part.url);
		files.push(
			keep
				? part
				: {
						type: "text",
						text: `[The person attached "${part.filename ?? "a file"}" (${part.mediaType}) earlier. It is not included any more, to make room. If you need it, ask them to attach it again.]`,
					},
		);
	}
	return files;
}
