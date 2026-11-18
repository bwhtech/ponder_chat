import { clockTime } from "../dates";
import { count, money } from "../numbers";
import { failureCause, failureReason, fileSize, type LogEntry } from "./documents";

/**
 * The indexing log in words. The server keeps numbers and labels only
 * (server/workspaces/documents/log.ts). For the admin's log (DocumentLogDialog.vue), stepView
 * turns each step into a title, a line of facts, how long it took and what it cost, and
 * pageGroupView adds up a run's page reads. For an editor's Details (DocumentDetails.vue, in
 * the side panel), plainSteps tells what happened, and no more, and pageReadsLine says in one
 * line how many pages a model read. A long PDF can have hundreds of page reads, so both logs
 * show a run's pages as one step (groupPageReads), with the page numbers as ranges (pageRanges).
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

/**
 * A log with each run's page reads that went well in one group, where the run's first page
 * read was. A page that the model could not read stays a step of its own, so it shows.
 */
export type LogItem = { kind: "step"; entry: LogEntry } | { kind: "pages"; entries: LogEntry[] };

export function groupPageReads(entries: LogEntry[]): LogItem[] {
	const groups = new Map<number, LogEntry[]>();
	const items: LogItem[] = [];
	for (const entry of entries) {
		if (entry.step !== "page-read" || entry.detail.ok === false) {
			items.push({ kind: "step", entry });
			continue;
		}
		const group = groups.get(entry.generation);
		if (group) {
			group.push(entry);
			continue;
		}
		const created = [entry];
		groups.set(entry.generation, created);
		items.push({ kind: "pages", entries: created });
	}
	return items;
}

/** Page numbers as short ranges, in order: "2–5, 9, 12–13". */
export function pageRanges(pages: number[]) {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let index = 0; index < sorted.length; index++) {
		const first = sorted[index];
		while (sorted[index + 1] === sorted[index] + 1) index++;
		const last = sorted[index];
		ranges.push(first === last ? count(first) : `${count(first)}–${count(last)}`);
	}
	return ranges.join(", ");
}

/** "Page 3" or "Pages 2–5, 9". */
function pagesNamed(pages: number[]) {
	return `${pages.length === 1 ? "Page" : "Pages"} ${pageRanges(pages)}`;
}

function pageNumbers(entries: LogEntry[]) {
	return entries.map((entry) => Number(entry.detail.page)).filter(Number.isFinite);
}

/** A run's page reads, for the admin: "34 pages read by google/gemini-3.8-flash", the pages, and their time and cost added up. */
export function pageGroupView(entries: LogEntry[]): StepView {
	const models = [...new Set(entries.map((entry) => text(entry.detail.model)).filter(Boolean))];
	const by = models.length === 1 ? models[0] : models.length ? `${count(models.length)} models` : "a model";
	const ms = entries.reduce((sum, entry) => sum + (typeof entry.detail.ms === "number" ? entry.detail.ms : 0), 0);
	const costs = entries.flatMap((entry) => (entry.costUsd === null ? [] : [entry.costUsd]));
	return {
		title: `${plural(entries.length, "page")} read by ${by}`,
		facts: pagesNamed(pageNumbers(entries)),
		error: null,
		time: duration(ms) ?? "",
		cost: costs.length ? money(costs.reduce((sum, cost) => sum + cost, 0)) : null,
		tone: "plain",
	};
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
 * The same log in plain steps, for the Details of people who edit the workspace: what
 * happened, without models, times or costs. "Uploaded · PDF, 3 pages", "Read 34 pages from
 * pictures" with the pages under it ("Pages 2–20, 31–45"), "Ready". Reading the text,
 * splitting it and indexing it fold into Uploaded and Ready. A step that failed is titled as
 * the document's row says it (failureReason), with its cause only when that has plain words;
 * a page that could not be read is one step, not a second "failed". The admin's log keeps
 * every detail (stepView).
 */
export type PlainStep = { step: LogEntry["step"]; title: string; facts: string; pages: string | null; error: string | null; failed: boolean };

export function plainSteps(entries: LogEntry[]): PlainStep[] {
	const runs = new Map<number, LogEntry[]>();
	for (const entry of entries) {
		const run = runs.get(entry.generation);
		if (run) run.push(entry);
		else runs.set(entry.generation, [entry]);
	}
	return groupPageReads(entries).flatMap((item) => {
		if (item.kind === "pages") return [pagesStep(item.entries)];
		const step = plainStep(item.entry, runs.get(item.entry.generation) ?? []);
		return step ? [step] : [];
	});
}

function plainStep(entry: LogEntry, run: LogEntry[]): PlainStep | null {
	const { detail } = entry;
	const plain = { step: entry.step, facts: "", pages: null, error: null, failed: false };
	switch (entry.step) {
		case "uploaded": {
			const pages = detail.mediaType === "application/pdf" ? plural(run.find((other) => other.step === "parsed")?.detail.pages, "page") : null;
			return { ...plain, title: "Uploaded", facts: [typeName(detail.mediaType), pages].filter(Boolean).join(", ") };
		}
		case "reindexed":
			return { ...plain, title: "Read again", facts: detail.reason === "model-changed" ? "The search model changed" : reindexReason(detail) };
		case "page-read":
			// Only a page that the model could not read: the others are one step (pagesStep).
			return { ...plain, title: failureReason(`Page ${text(detail.page)}`), error: failureCause(text(detail.error)), failed: true };
		case "ready":
			return { ...plain, title: "Ready" };
		case "failed":
			return failedStep(entry, run);
		default:
			return null;
	}
}

/** A run's pages that a model read from pictures: "Read page 2 from a picture", or "Read 34 pages from pictures" and which. */
function pagesStep(entries: LogEntry[]): PlainStep {
	const pages = pageNumbers(entries);
	const plain = { step: "page-read" as const, facts: "", error: null, failed: false };
	if (pages.length === 1) return { ...plain, title: `Read page ${count(pages[0])} from a picture`, pages: null };
	return { ...plain, title: `Read ${count(pages.length)} pages from pictures`, pages: pagesNamed(pages) };
}

/** The run's end when it failed; none when the page that stopped it already says so. */
function failedStep(entry: LogEntry, run: LogEntry[]): PlainStep | null {
	const { detail } = entry;
	const page = detail.page === undefined || detail.page === null ? null : text(detail.page);
	if (page && run.some((other) => other.step === "page-read" && other.detail.ok === false && text(other.detail.page) === page)) return null;
	const error = text(detail.error) || null;
	return { step: entry.step, title: failureReason(error), facts: "", pages: null, error: failureCause(error), failed: true };
}

/** The steps of the latest run: "Try again" and a new search model start a run, which reads every page again. */
function latestRun(entries: LogEntry[]) {
	const latest = Math.max(...entries.map((entry) => entry.generation));
	return entries.filter((entry) => entry.generation === latest);
}

/**
 * What a model did in the latest run, for the line at the top of Details: "34 pages were read
 * from pictures" ("34 pages read from pictures so far" while it indexes), and the pages it
 * could not read. A page that stopped the run is left out: the document's status names it.
 * Null when there is nothing else to say.
 */
export function pageReadsLine(entries: LogEntry[], indexing: boolean): { read: string | null; unread: string | null } | null {
	const run = latestRun(entries);
	const reads = run.filter((entry) => entry.step === "page-read");
	if (!reads.length) return null;
	const stopped = run.find((entry) => entry.step === "failed")?.detail.page;
	const read = reads.filter((entry) => entry.detail.ok !== false).length;
	const unread = pageNumbers(reads.filter((entry) => entry.detail.ok === false && entry.detail.page !== stopped));
	if (!read && !unread.length) return null;
	return { read: read ? readText(read, indexing) : null, unread: unread.length ? `${pagesNamed(unread)} could not be read` : null };
}

function readText(pages: number, indexing: boolean) {
	if (indexing) return `${count(pages)} ${pages === 1 ? "page" : "pages"} read from ${pages === 1 ? "a picture" : "pictures"} so far`;
	return pages === 1 ? "1 page was read from a picture" : `${count(pages)} pages were read from pictures`;
}

/** When the latest run ended Ready; null while it runs, or when it failed. */
export function readyAt(entries: LogEntry[]) {
	return latestRun(entries).find((entry) => entry.step === "ready")?.at ?? null;
}

/** A PDF's number of pages, from the latest run that parsed it; null for other files, or before it is parsed. */
export function pageCount(entries: LogEntry[]) {
	const pages = entries.filter((entry) => entry.step === "parsed").map((entry) => entry.detail.pages);
	const last = pages[pages.length - 1];
	return typeof last === "number" ? last : null;
}

/** A document's type in a word, such as "PDF" or "Markdown"; null for a type it does not know. */
export function typeLabel(mediaType: string) {
	return typeName(mediaType);
}
