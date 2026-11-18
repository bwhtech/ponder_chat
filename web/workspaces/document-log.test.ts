import { describe, expect, it } from "vitest";
import { groupPageReads, pageGroupView, pageRanges, pageReadsLine, plainSteps } from "./document-log";
import type { LogEntry } from "./documents";

const AT = "2026-11-18T10:00:00.000Z";

function entry(step: LogEntry["step"], detail: LogEntry["detail"] = {}, generation = 1, costUsd: number | null = null): LogEntry {
	return { generation, step, at: AT, detail, costUsd };
}

function pageRead(page: number, { ok = true, generation = 1, ms = 1000, costUsd = 0.001 } = {}) {
	return entry("page-read", { page, ok, reason: "scan", model: "google/gemini-3.8-flash", ms, attempts: 1, error: ok ? null : "The model returned no text." }, generation, costUsd);
}

/** A PDF of `pages` pages whose `read` pages a model read, then Ready. */
function run(pages: number, read: number[], { failed = [] as number[], generation = 1 } = {}) {
	const reads = [...read.map((page) => pageRead(page, { generation })), ...failed.map((page) => pageRead(page, { ok: false, generation }))].sort((a, b) => Number(a.detail.page) - Number(b.detail.page));
	return [
		entry(generation === 1 ? "uploaded" : "reindexed", { size: 2_400_000, mediaType: "application/pdf", reason: "retry" }, generation),
		entry("parsed", { engine: "liteparse", pages, chars: 90_000, ms: 800 }, generation),
		...reads,
		entry("chunked", { passages: 120, batches: 2 }, generation),
		entry("ready", { passages: 120 }, generation),
	];
}

describe("page numbers as ranges", () => {
	it("joins pages that follow each other, in order, once each", () => {
		expect(pageRanges([23, 17, 18, 19, 20, 21, 25, 28, 251, 252, 253, 18])).toBe("17–21, 23, 25, 28, 251–253");
	});

	it("keeps a single page and two pages in a row", () => {
		expect(pageRanges([4])).toBe("4");
		expect(pageRanges([4, 5])).toBe("4–5");
		expect(pageRanges([])).toBe("");
	});

	it("writes large page numbers with a thousands separator", () => {
		expect(pageRanges([1200, 1201, 1202])).toBe("1,200–1,202");
	});
});

describe("a long PDF's page reads in the editor's log", () => {
	it("shows a run's pages as one step, with the pages as ranges", () => {
		const pages = [...range(17, 21), 23, 25, 28, ...range(251, 253)];
		expect(plainSteps(run(398, pages))).toEqual([
			{ step: "uploaded", title: "Uploaded", facts: "PDF, 398 pages", pages: null, error: null, failed: false },
			{ step: "page-read", title: "Read 11 pages from pictures", facts: "", pages: "Pages 17–21, 23, 25, 28, 251–253", error: null, failed: false },
			{ step: "ready", title: "Ready", facts: "", pages: null, error: null, failed: false },
		]);
	});

	it("says one page as before", () => {
		expect(plainSteps(run(2, [2])).map((step) => step.title)).toEqual(["Uploaded", "Read page 2 from a picture", "Ready"]);
	});

	it("keeps a page the model could not read as a step of its own, after the run's pages", () => {
		const steps = plainSteps(run(40, [3, 4, 6], { failed: [5] }));
		expect(steps.map((step) => [step.title, step.pages, step.failed])).toEqual([
			["Uploaded", null, false],
			["Read 3 pages from pictures", "Pages 3–4, 6", false],
			["Could not read page 5", null, true],
			["Ready", null, false],
		]);
	});

	it("groups each run apart: Try again reads the pages again", () => {
		const log = [...run(10, [2, 3], { failed: [4] }).slice(0, -2), entry("failed", { step: "page-read", page: 4, error: "Page 4 has no text, and the model could not read it." }), ...run(10, [2, 3, 4], { generation: 2 })];
		expect(plainSteps(log).map((step) => step.title)).toEqual(["Uploaded", "Read 2 pages from pictures", "Could not read page 4", "Read again", "Read 3 pages from pictures", "Ready"]);
	});
});

describe("the line on page reads at the top of Details", () => {
	it("counts the latest run's pages", () => {
		expect(pageReadsLine(run(398, range(1, 34)), false)).toEqual({ read: "34 pages were read from pictures", unread: null });
		expect(pageReadsLine(run(3, [2]), false)).toEqual({ read: "1 page was read from a picture", unread: null });
	});

	it("says so far while the document indexes", () => {
		expect(pageReadsLine(run(398, range(1, 12)).slice(0, -2), true)?.read).toBe("12 pages read from pictures so far");
	});

	it("names a page that could not be read, unless it stopped the run", () => {
		expect(pageReadsLine(run(40, [3, 4], { failed: [5, 9] }), false)).toEqual({ read: "2 pages were read from pictures", unread: "Pages 5, 9 could not be read" });
		const stopped = [...run(10, [2], { failed: [4] }).slice(0, -2), entry("failed", { step: "page-read", page: 4, error: "Page 4 has no text." })];
		expect(pageReadsLine(stopped, false)).toEqual({ read: "1 page was read from a picture", unread: null });
		const first = [...run(10, [], { failed: [2] }).slice(0, -2), entry("failed", { step: "page-read", page: 2, error: "Page 2 has no text." })];
		expect(pageReadsLine(first, false)).toBeNull();
	});

	it("is none when no page went to a model", () => {
		expect(pageReadsLine(run(5, []), false)).toBeNull();
	});
});

describe("a run's page reads in the admin's log", () => {
	it("is one row with the model, the pages, and the time and cost added up", () => {
		const items = groupPageReads(run(398, range(1, 34), { failed: [35] }));
		expect(items.map((item) => (item.kind === "pages" ? `pages:${item.entries.length}` : item.entry.step))).toEqual(["uploaded", "parsed", "pages:34", "page-read", "chunked", "ready"]);
		const group = items.find((item) => item.kind === "pages");
		expect(group?.kind === "pages" && pageGroupView(group.entries)).toMatchObject({ title: "34 pages read by google/gemini-3.8-flash", facts: "Pages 1–34", time: "34 s", cost: "$0.03" });
	});
});

function range(first: number, last: number) {
	return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
