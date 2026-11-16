/**
 * Splits the end-to-end tests into CI shards by how long each test took (durations.json),
 * so that the shards end at about the same time. Playwright's own --shard splits by count,
 * and one slow file then holds up its shard.
 *
 *   node e2e/shard.ts 2 6                 prints the tests of shard 2 of 6, for `playwright test`
 *   node e2e/shard.ts --update a.json …   writes durations.json from Playwright JSON reports
 *
 * Each shard runs WORKERS workers (playwright.config.ts). A test goes to the worker that
 * is free first, longest test first, so each shard gets about the same time. A test that
 * durations.json does not know counts as the median test.
 *
 * A file whose tests run one at a time (a serial describe, or a durability file) stays
 * whole, on one worker, and counts SERVER_START more for the server it starts. These
 * files get shards of their own: Playwright takes files in alphabetical order, so on a
 * shard with other tests a long serial file could start last and end late.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DURATIONS = join(import.meta.dirname, "durations.json");
const TESTS = join(import.meta.dirname, "tests");
/** Workers per shard: as many as the runner has cores (playwright.config.ts). */
const WORKERS = Number(process.env.E2E_WORKERS ?? 2);
/** What a serial file adds to its tests' time: a new database and a Ponder of its own (durability.ts), measured in CI. */
const SERVER_START = 8_000;

type Spec = { title: string; file: string; line: number };
type Suite = { specs?: Spec[]; suites?: Suite[] };
type ResultSpec = Spec & { tests: { results: { duration: number }[] }[] };

const [first, ...rest] = process.argv.slice(2);
if (first === "--update") update(rest);
else console.log(shard(Number(first), Number(rest[0])).join(" "));

function shard(index: number, total: number): string[] {
	if (!(Number.isInteger(index) && Number.isInteger(total) && index >= 1 && index <= total)) {
		throw new Error("Usage: node e2e/shard.ts <index> <total>, such as 2 6.");
	}
	const durations: Record<string, number> = JSON.parse(readFileSync(DURATIONS, "utf8"));
	const known = Object.values(durations).sort((a, b) => a - b);
	const median = known[Math.floor(known.length / 2)] ?? 5_000;
	const serialUnits = new Map<string, Unit>();
	const testUnits = new Map<string, Unit>();
	for (const spec of listed()) {
		const ms = durations[key(spec)] ?? median;
		if (serial(spec.file)) {
			const unit = serialUnits.get(spec.file) ?? { args: [`e2e/tests/${spec.file}`], ms: SERVER_START };
			unit.ms += ms;
			serialUnits.set(spec.file, unit);
		} else testUnits.set(`${spec.file}:${spec.line}`, { args: [`e2e/tests/${spec.file}:${spec.line}`], ms });
	}
	// The serial files get as many shards as their share of the time, at least one, and leave at least one for the rest.
	const sum = (units: Map<string, Unit>) => [...units.values()].reduce((all, unit) => all + unit.ms, 0);
	const serialShards = serialUnits.size === 0 ? 0 : Math.min(total - 1, Math.max(1, Math.round((total * sum(serialUnits)) / (sum(serialUnits) + sum(testUnits)))));
	const workers = [...spread(serialUnits, serialShards), ...spread(testUnits, total - serialShards)];
	const mine = workers.slice((index - 1) * WORKERS, index * WORKERS);
	const args = mine.flatMap((worker) => worker.args).sort();
	if (args.length === 0) throw new Error(`Shard ${index} of ${total} has no tests: use fewer shards.`);
	const seconds = mine.map((worker) => (worker.ms / 1000).toFixed(0)).join(" + ");
	console.error(`Shard ${index} of ${total}: ${args.length} files or tests, about ${seconds} seconds of tests on ${WORKERS} workers.`);
	return args;
}

type Unit = { args: string[]; ms: number };

/** The units on `shards` shards' workers: longest first, each to the worker that is free first. Ties go to the lowest worker, so every shard computes the same split. */
function spread(units: Map<string, Unit>, shards: number) {
	const workers = Array.from({ length: shards * WORKERS }, () => ({ ms: 0, args: [] as string[] }));
	const sorted = [...units.entries()].sort(([a, x], [b, y]) => y.ms - x.ms || a.localeCompare(b));
	for (const [, unit] of sorted) {
		const free = workers.reduce((best, worker) => (worker.ms < best.ms ? worker : best));
		free.ms += unit.ms;
		free.args.push(...unit.args);
	}
	return workers;
}

/** Every test that Playwright would run, from its own list. */
function listed(): Spec[] {
	const out = execFileSync("npx", ["--no-install", "playwright", "test", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const specs: Spec[] = [];
	const walk = (suite: Suite) => {
		specs.push(...(suite.specs ?? []));
		suite.suites?.forEach(walk);
	};
	(JSON.parse(out) as { suites: Suite[] }).suites.forEach(walk);
	return specs;
}

/** A file whose tests share one server or one state, so they must stay together. */
function serial(file: string) {
	const source = readFileSync(join(TESTS, file), "utf8");
	return /mode:\s*"serial"/.test(source) || source.includes("durableServer(");
}

function key(spec: Spec) {
	return `${spec.file} › ${spec.title}`;
}

/** Rewrites durations.json from the JSON reports of a CI run: each test's first attempt, in ms. */
function update(reports: string[]) {
	const durations: Record<string, number> = {};
	for (const report of reports) {
		const walk = (suite: Suite) => {
			for (const spec of (suite.specs ?? []) as ResultSpec[]) {
				const ms = spec.tests[0]?.results[0]?.duration;
				if (ms !== undefined) durations[key(spec)] = Math.round(ms);
			}
			suite.suites?.forEach(walk);
		};
		(JSON.parse(readFileSync(report, "utf8")) as { suites: Suite[] }).suites.forEach(walk);
	}
	const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(DURATIONS, `${JSON.stringify(sorted, null, "\t")}\n`);
	console.log(`Wrote ${Object.keys(sorted).length} durations to ${DURATIONS}.`);
}
