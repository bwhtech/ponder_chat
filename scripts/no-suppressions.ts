/**
 * Fails on comments that turn a lint rule off in our code: the rules have no exceptions
 * (README.md, "No `any`"). oxlint has no setting to ignore them, so this reads every file.
 * TypeScript's own comments (@ts-ignore and the like) are oxlint's ban-ts-comment rule;
 * vue-tsc's template comments (@vue- followed by ignore, expect-error or skip) are here. `npm run lint` runs it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CODE = /\.(ts|tsx|mts|cts|vue|js|mjs|cjs)$/;
// The disable and enable comments, inline rule settings (a block comment that starts with
// the linter's name), and vue-tsc's template comments. Spelled in parts, so that this file
// does not match itself.
const SUPPRESSION = /(?:es|ox)lint-(?:dis|en)able|\/\*\s*(?:es|ox)lint\s|@vue-(?:ignore|expect-error|skip)/;

const found = trackedAndNewFiles()
	.filter((path) => CODE.test(path))
	.flatMap((path) => suppressionsIn(path));

for (const line of found) console.error(line);
if (found.length > 0) {
	console.error(`${found.length} comment(s) turn a rule off. Fix the code instead.`);
	process.exit(1);
}

/** Every file git tracks or would track: ignored files (node_modules, builds) are out. */
function trackedAndNewFiles(): string[] {
	const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
	return out.split("\n").filter((path) => path !== "");
}

function suppressionsIn(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return []; // Deleted but not yet staged.
	}
	return text
		.split("\n")
		.flatMap((line, index) => (SUPPRESSION.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []));
}
