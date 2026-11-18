import { clockTime } from "../dates";
import { count, money } from "../numbers";
import { failureCause, failureReason, fileSize, type LogEntry } from "./documents";

/**
 * The indexing log in words. The server keeps numbers and labels only
 * (server/workspaces/documents/log.ts). For the admin's log (DocumentLogDialog.vue), stepView
 * turns each step into a title, a line of facts, how long it took and what it cost. For an
 * editor's Details (DocumentDetailsDialog.vue), plainSteps tells what happened, and no more.
 */
export type StepView = {
	title: string;
	/** The facts, joined with " · ". */
	facts: string;
	/** A model call or a run that failed, in its own words. */
	error: string | null;
	/** "1.2 s"; the time of day for the step that starts a run; empty for a step that has neither. */
	time: string;
	/** What the step's model calls cost; for Ready and Failed, the whole run. */
	cost: string | null;
	tone: "plain" | "done" | "failed";
};

type Detail = LogEntry["detail"];

const STAGES: Record<string, string> = {
	parse: "reading the text",
	"page-read": "reading a page with a model",
	chunk: "splitting it into passages",
	embed: "embedding the passages",
	finish: "finishing",
};

export function stepView(entry: LogEntry): StepView {
	const { detail } = entry;
	const starts = entry.step === "uploaded" || entry.step === "reindexed";
	const base = { error: null, time: duration(detail.ms) ?? (starts ? clockTime(entry.at) : ""), cost: entry.costUsd === null ? null : money(entry.costUsd), tone: "plain" as const };
	switch (entry.step) {
		case "uploaded":
			return { ...base, title: "Uploaded", facts: join(size(detail.size), typeName(detail.mediaType)) };
		case "reindexed":
			return { ...base, title: "Read again", facts: reindexReason(detail) };
		case "parsed":
			return { ...base, title: "Read the text", facts: join(engineName(detail.engine), plural(detail.pages, "page"), plural(detail.chars, "character")) };
		case "page-read":
			return {
				...base,
				title: `Page ${text(detail.page)} read by a model`,
				facts: join(detail.reason === "scan" ? "A scan, with no text" : "A picture covers part of it", text(detail.model), Number(detail.attempts) > 1 ? plural(detail.attempts, "try", "tries") : null),
				error: detail.ok === false ? text(detail.error) || "The model could not read it." : null,
				tone: detail.ok === false ? "failed" : "plain",
			};
		case "chunked":
			return { ...base, title: "Split into passages", facts: join(plural(detail.passages, "passage"), plural(detail.batches, "batch", "batches")) };
		case "embedded":
			return { ...base, title: `Embedded batch ${count(Number(detail.batch) + 1)}`, facts: join(plural(detail.passages, "passage"), text(detail.model)) };
		case "ready":
			return { ...base, title: "Ready", facts: plural(detail.passages, "passage") ?? "", cost: total(entry), tone: "done" };
		case "failed":
			return {
				...base,
				title: `Failed while ${STAGES[text(detail.step)] ?? "indexing"}`,
				facts: detail.page === undefined || detail.page === null ? "" : `Page ${text(detail.page)}`,
				error: text(detail.error) || "Something went wrong.",
				cost: total(entry),
				tone: "failed",
			};
	}
}

/** A run's last step carries what all its model calls cost (log.ts). */
function total(entry: LogEntry) {
	return entry.costUsd === null ? null : `${money(entry.costUsd)} in total`;
}

/** "450 ms", "1.2 s" or "2 min 5 s"; none when the step has no time. */
export function duration(ms: Detail[string] | undefined) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
	if (ms < 1000) return `${count(Math.round(ms))} ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${count(Math.round(seconds * 10) / 10)} s`;
	const minutes = Math.floor(seconds / 60);
	return `${count(minutes)} min ${count(Math.round(seconds - minutes * 60))} s`;
}

function plural(value: Detail[string] | undefined, one: string, many = `${one}s`) {
	if (typeof value !== "number") return null;
	return `${count(value)} ${value === 1 ? one : many}`;
}

function size(value: Detail[string] | undefined) {
	return typeof value === "number" ? fileSize(value) : null;
}

function engineName(engine: Detail[string] | undefined) {
	if (engine === "liteparse") return "LiteParse";
	if (engine === "pdf-text") return "PDF text layer";
	if (engine === "text") return "Plain text";
	return text(engine) || null;
}

function typeName(mediaType: Detail[string] | undefined) {
	const names: Record<string, string> = {
		"application/pdf": "PDF",
		"text/plain": "Text",
		"text/markdown": "Markdown",
		"text/csv": "CSV",
		"text/tab-separated-values": "TSV",
		"application/json": "JSON",
	};
	return names[text(mediaType)] ?? null;
}

function text(value: Detail[string] | undefined) {
	return value === null || value === undefined ? "" : String(value);
}

function reindexReason(detail: Detail) {
	if (detail.reason === "model-changed") return join("The embedding model changed", text(detail.to));
	if (detail.reason === "stalled") return "Indexing had stopped, so it started again";
	return "An editor asked to try again";
}

function join(...parts: (string | null)[]) {
	return parts.filter(Boolean).join(" · ");
}

/**
 * The same log in plain steps, for the Details view of people who edit the workspace: what
 * happened, without models, times or costs. "Uploaded · PDF, 3 pages", "Read page 2 from a
 * picture", "Ready". Reading the text, splitting it and indexing it fold into Uploaded and
 * Ready. A step that failed is titled as the document's row says it (failureReason), with its
 * cause only when that has plain words; a page that could not be read is one step, not a
 * second "failed". The admin's log keeps every detail (stepView).
 */
export type PlainStep = { step: LogEntry["step"]; title: string; facts: string; error: string | null; failed: boolean };

export function plainSteps(entries: LogEntry[]): PlainStep[] {
	return entries.flatMap((entry) => {
		const step = plainStep(
			entry,
			entries.filter((other) => other.generation === entry.generation),
		);
		return step ? [step] : [];
	});
}

function plainStep(entry: LogEntry, run: LogEntry[]): PlainStep | null {
	const { detail } = entry;
	const plain = { step: entry.step, facts: "", error: null, failed: false };
	switch (entry.step) {
		case "uploaded": {
			const pages = detail.mediaType === "application/pdf" ? plural(run.find((other) => other.step === "parsed")?.detail.pages, "page") : null;
			return { ...plain, title: "Uploaded", facts: [typeName(detail.mediaType), pages].filter(Boolean).join(", ") };
		}
		case "reindexed":
			return { ...plain, title: "Read again", facts: detail.reason === "model-changed" ? "The search model changed" : reindexReason(detail) };
		case "page-read":
			if (detail.ok === false) return { ...plain, title: failureReason(`Page ${text(detail.page)}`), error: failureCause(text(detail.error)), failed: true };
			return { ...plain, title: `Read page ${text(detail.page)} from a picture` };
		case "ready":
			return { ...plain, title: "Ready" };
		case "failed":
			return failedStep(entry, run);
		default:
			return null;
	}
}

/** The run's end when it failed; none when the page that stopped it already says so. */
function failedStep(entry: LogEntry, run: LogEntry[]): PlainStep | null {
	const { detail } = entry;
	const page = detail.page === undefined || detail.page === null ? null : text(detail.page);
	if (page && run.some((other) => other.step === "page-read" && other.detail.ok === false && text(other.detail.page) === page)) return null;
	const error = text(detail.error) || null;
	return { step: entry.step, title: failureReason(error), facts: "", error: failureCause(error), failed: true };
}
