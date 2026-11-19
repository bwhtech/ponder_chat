/**
 * POC, not for main: compares our web_fetch (server/search/fetch-page.ts) with
 * Firecrawl Local's /v2/scrape on the same addresses. Findings: the issue that links here.
 *
 * Setup (Rust in a scratch folder, nothing system-wide):
 *   RUSTUP_HOME=… CARGO_HOME=… sh rustup.sh -y --profile minimal --no-modify-path
 *   cargo install firecrawl-local --root <dir>            (about 5 minutes, 24 MB binary)
 *   FIRECRAWL_CLOUD=off FIRECRAWL_CHROME_PATH=<chrome> firecrawl-local serve --port 3602
 * On Ubuntu, Chrome needs an AppArmor profile that allows user namespaces, or it dies
 * with "No usable sandbox". On this server, T3 Code's chrome-headless-shell has one.
 * Add FIRECRAWL_LOCAL_BROWSER=always to render every page in Chrome.
 *
 * Run:
 *   FIRECRAWL_URL=http://127.0.0.1:3602 OUT=/some/dir npx tsx scripts/poc/firecrawl-compare.ts
 *
 * It prints one row per address (ok or FAIL, time, characters, markdown headings, links
 * and table rows) and writes each tool's text to OUT for reading by hand. Our fetcher
 * runs first for each address, so Firecrawl can get a warm CDN cache.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPromise } from "../../server/runtime/runtime.ts";
import { fetchPage as fetchPageEffect } from "../../server/search/fetch-page.ts";

const fetchPage = (address: string) => runPromise(fetchPageEffect(address));

const FIRECRAWL_URL = process.env.FIRECRAWL_URL ?? "http://127.0.0.1:3602";
const OUT = process.env.OUT ?? "/tmp/firecrawl-compare";

type Case = { name: string; url: string; kind: "page" | "spa" | "file" | "blocked" | "private" };

const CASES: Case[] = [
	{ name: "wikipedia-article", url: "https://en.wikipedia.org/wiki/Readability", kind: "page" },
	{ name: "wikipedia-table", url: "https://en.wikipedia.org/wiki/List_of_countries_by_population_(United_Nations)", kind: "page" },
	{ name: "essay", url: "https://www.paulgraham.com/greatwork.html", kind: "page" },
	{ name: "mdn-docs", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301", kind: "page" },
	{ name: "news-front", url: "https://www.bbc.com/news", kind: "page" },
	{ name: "github-repo", url: "https://github.com/firecrawl/firecrawl", kind: "page" },
	{ name: "hn-front", url: "https://news.ycombinator.com/", kind: "page" },
	{ name: "crates-spa", url: "https://crates.io/crates/firecrawl-local", kind: "spa" },
	{ name: "excalidraw-spa", url: "https://excalidraw.com/", kind: "spa" },
	{ name: "pdf-arxiv", url: "https://arxiv.org/pdf/1706.03762", kind: "file" },
	{ name: "docx", url: "https://calibre-ebook.com/downloads/demos/demo.docx", kind: "file" },
	{ name: "reddit", url: "https://www.reddit.com/r/programming/", kind: "blocked" },
	{ name: "x-profile", url: "https://x.com/firecrawl", kind: "blocked" },
	{ name: "medium", url: "https://medium.com/@karpathy/software-2-0-a64152b37c35", kind: "blocked" },
	{ name: "loopback", url: "http://127.0.0.1:3602/health", kind: "private" },
	{ name: "metadata", url: "http://169.254.169.254/latest/meta-data/", kind: "private" },
	{ name: "tailscale-dns", url: "http://100.100.100.100/", kind: "private" },
	{ name: "tailnet-name", url: "https://hussain-coding.tail5c9b7d.ts.net/", kind: "private" },
	{ name: "ipv6-loopback", url: "http://[::1]/", kind: "private" },
	{ name: "name-to-metadata", url: "http://169.254.169.254.nip.io/latest/meta-data/", kind: "private" },
	{ name: "name-to-loopback", url: "http://127.0.0.1.nip.io/", kind: "private" },
	{ name: "name-to-10net", url: "http://10.0.0.1.sslip.io/", kind: "private" },
	{ name: "name-to-cgnat", url: "http://100.100.100.100.nip.io/", kind: "private" },
];

type Outcome = { ok: boolean; ms: number; chars: number; headings: number; links: number; tableRows: number; note: string; text: string };

const shape = (text: string) => ({
	chars: text.length,
	headings: (text.match(/^#{1,6} /gm) ?? []).length,
	links: (text.match(/\]\(https?:/g) ?? []).length,
	tableRows: (text.match(/^\|.*\|$/gm) ?? []).length,
});

async function ours(url: string): Promise<Outcome> {
	const start = performance.now();
	try {
		const page = await fetchPage(url);
		return { ok: true, ms: performance.now() - start, ...shape(page.text), note: page.truncated ? "truncated at 20k" : "", text: page.text };
	} catch (error) {
		return { ok: false, ms: performance.now() - start, chars: 0, headings: 0, links: 0, tableRows: 0, note: String((error as Error).message), text: "" };
	}
}

type ScrapeReply = { success?: boolean; error?: string; data?: { markdown?: string; warning?: string; metadata?: { statusCode?: number; error?: string } } };

async function firecrawl(url: string): Promise<Outcome> {
	const start = performance.now();
	try {
		const response = await fetch(`${FIRECRAWL_URL}/v2/scrape`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url, formats: ["markdown"], timeout: 30_000 }),
			signal: AbortSignal.timeout(60_000),
		});
		const reply = (await response.json()) as ScrapeReply;
		const markdown = reply.data?.markdown ?? "";
		const status = reply.data?.metadata?.statusCode;
		const note = [reply.error, reply.data?.warning, reply.data?.metadata?.error, status && status >= 400 ? `status ${status}` : ""].filter(Boolean).join("; ");
		const ok = Boolean(reply.success) && markdown.length > 0 && !(status && status >= 400);
		return { ok, ms: performance.now() - start, ...shape(markdown), note: note.slice(0, 160), text: markdown };
	} catch (error) {
		return { ok: false, ms: performance.now() - start, chars: 0, headings: 0, links: 0, tableRows: 0, note: String((error as Error).message), text: "" };
	}
}

const cell = (o: Outcome) => `${o.ok ? "ok" : "FAIL"} ${Math.round(o.ms)}ms ${o.chars}c h${o.headings} l${o.links} t${o.tableRows}`;

mkdirSync(OUT, { recursive: true });
const rows: Array<{ case: Case; ours: Outcome; firecrawl: Outcome }> = [];
for (const item of CASES) {
	const a = await ours(item.url);
	const b = await firecrawl(item.url);
	writeFileSync(join(OUT, `${item.name}.ours.txt`), a.text || a.note);
	writeFileSync(join(OUT, `${item.name}.firecrawl.md`), b.text || b.note);
	rows.push({ case: item, ours: a, firecrawl: b });
	console.log(`${item.kind.padEnd(8)} ${item.name.padEnd(22)} | ${cell(a).padEnd(38)} | ${cell(b)}`);
	if (a.note || b.note) console.log(`${"".padEnd(32)} ours: ${a.note.slice(0, 100) || "-"} | fc: ${b.note.slice(0, 100) || "-"}`);
}
writeFileSync(join(OUT, "results.json"), JSON.stringify(rows.map((r) => ({ ...r, ours: { ...r.ours, text: undefined }, firecrawl: { ...r.firecrawl, text: undefined } })), null, 2));
// The app runtime (Postgres pool, tracing) keeps the process alive.
process.exit(0);
