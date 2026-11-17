/**
 * Reads the eval manuals with the PDF reader and the chunker, and prints for each question
 * whether a passage of its page holds the answer, and the passages' sizes. Search is not
 * built yet: the next step adds the top-8 hit rate (README.md).
 *
 * Run:
 *   WORKSPACE_EVAL_DIR=<folder with the PDFs> npx tsx server/workspaces/eval/run.ts [options]
 *   --live             read the picture pages with the real model (about $0.06), and save
 *                      its text in WORKSPACE_EVAL_DIR/model-pages.json for the next runs.
 *                      Needs the app's environment: set -a; . ~/.config/ponder-chat/.env; set +a
 *   --recorded <file>  answer picture pages from another file of model text
 *   --passages <file>  write every passage to a JSON file, to read them
 * Without --live, the picture pages come from model-pages.json. A picture page that is not
 * in it keeps LiteParse's text, and a page with no text fails its document.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { chunkDocument, TARGET, type Passage } from "../documents/chunk.ts";
import type { DocumentText } from "../documents/document.ts";
import type * as PageReader from "../documents/page-reader.ts";
import { readPdf } from "../documents/read-pdf.ts";
import type * as PdfText from "../../pdf-text.ts";
import { liveLayer, recordedLayer } from "./layers.ts";

type Question = { id: string; document: string; question: string; pages: number[]; answer: string; source: "text" | "table" | "picture" };
type Questions = { documents: { file: string; name: string }[]; questions: Question[] };
type ModelPages = Record<string, { text: string }>;

const dir = process.env.WORKSPACE_EVAL_DIR;
if (!dir) {
	console.error("Set WORKSPACE_EVAL_DIR to the folder with the manuals' PDFs.");
	process.exit(2);
}
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const live = args.includes("--live");
const modelPagesFile = join(dir, "model-pages.json");
const recorded = loadModelPages(option("--recorded") ?? modelPagesFile);
const passagesFile = option("--passages");
const { documents, questions } = JSON.parse(readFileSync(new URL("./questions.json", import.meta.url), "utf8")) as Questions;

const passagesOf = new Map<string, Passage[]>();
for (const document of documents) {
	const data = new Uint8Array(readFileSync(join(dir, document.file)));
	const stem = document.file.replace(/\.pdf$/, "");
	const text = live ? await readWith(liveLayer, data) : await readWith(recordedLayer(pagesOf(recorded, stem)), data);
	if (typeof text === "string") {
		console.log(`${document.file}: failed: ${text}`);
		continue;
	}
	if (live) saveModelPages(stem, text);
	const passages = chunkDocument({ name: document.name, pages: text.pages, headings: "numbered" });
	passagesOf.set(document.file, passages);
	const cost = text.pageReads.reduce((sum, page) => sum + (page.costUsd ?? 0), 0);
	const failed = text.pageReads.filter((page) => !page.ok).length;
	console.log(`${document.file}: ${text.engine}, ${text.pageCount} pages, ${text.chars} chars, ${text.ms} ms; ${text.pageReads.length} pages to the model (${failed} not read, $${cost.toFixed(4)})`);
	console.log(`  ${sizes(passages)}`);
}

console.log("\nid      source   page   passage  answer");
let found = 0;
for (const question of questions) {
	const passages = passagesOf.get(question.document) ?? [];
	const onPage = passages.filter((passage) => question.pages.some((page) => covers(passages, passage, page)));
	const hit = onPage.some((passage) => normalize(passage.content).includes(normalize(question.answer)));
	if (hit) found++;
	console.log(`${question.id.padEnd(8)}${question.source.padEnd(9)}${question.pages.join(",").padEnd(7)}${(onPage.length ? "yes" : "no").padEnd(9)}${hit ? "yes" : "NO"}`);
}
console.log(`\nAnswer in a passage of its page: ${found}/${questions.length}`);

if (passagesFile) {
	writeFileSync(passagesFile, JSON.stringify(Object.fromEntries(passagesOf), null, 1));
	console.log(`Passages written to ${passagesFile}`);
}

/** The document's text, or why it could not be read. */
async function readWith<R, E>(layer: Layer.Layer<R | PageReader.PageReader | PdfText.PdfText, E>, data: Uint8Array): Promise<DocumentText | string> {
	const runtime = ManagedRuntime.make(layer);
	try {
		const exit = await runtime.runPromiseExit(readPdf(data));
		if (Exit.isSuccess(exit)) return exit.value;
		const error = Cause.squash(exit.cause);
		return error instanceof Error ? error.message : String(error);
	} finally {
		await runtime.dispose();
	}
}

/** Model text by "<file stem>-<page>". The scratch runs kept one object for each model, which is opened. */
function loadModelPages(file: string): ModelPages {
	if (!existsSync(file)) return {};
	const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const keys = Object.keys(all);
	return (keys.length === 1 && !/-\d+$/.test(keys[0]) ? all[keys[0]] : all) as ModelPages;
}

function pagesOf(pages: ModelPages, stem: string) {
	const texts = new Map<number, string>();
	for (const [key, value] of Object.entries(pages)) {
		const match = key.match(/^(.*)-(\d+)$/);
		if (match?.[1] === stem && value.text) texts.set(Number(match[2]), value.text);
	}
	return texts;
}

function saveModelPages(stem: string, text: DocumentText) {
	const saved = loadModelPages(modelPagesFile);
	for (const read of text.pageReads.filter((page) => page.ok)) {
		const page = text.pages.find((one) => one.page === read.page);
		if (page) saved[`${stem}-${read.page}`] = { text: page.markdown };
	}
	writeFileSync(modelPagesFile, JSON.stringify(saved, null, 1));
}

/** A passage covers a page when it starts on it, or starts before it and the next passage starts on it or later (it may run onto the page). */
function covers(passages: Passage[], passage: Passage, page: number) {
	if (passage.page === page) return true;
	const next = passages[passage.ordinal + 1];
	return passage.page !== null && passage.page < page && (next === undefined || (next.page ?? 0) >= page);
}

function normalize(text: string) {
	return text.toLowerCase().replace(/\s+/g, " ");
}

function sizes(passages: Passage[]) {
	const lengths = passages.map((passage) => passage.content.length).sort((a, b) => a - b);
	const at = (share: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * share))];
	const mean = Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length);
	const over = lengths.filter((length) => length > TARGET).length;
	return `${passages.length} passages; chars: mean ${mean}, median ${at(0.5)}, p10 ${at(0.1)}, p90 ${at(0.9)}, max ${lengths.at(-1)}; over ${TARGET}: ${over}`;
}
