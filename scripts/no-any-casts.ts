/**
 * Fails on a type assertion from `any`, such as `(await response.json()) as Thing` or
 * `workerData as Job`, in the .ts files (README.md, "No `any`"). The unsafe rules in
 * .oxlintrc.json let these through: the assertion turns `any` into a type. A cast from
 * `unknown` is fine: it is visible, and the value was never `any`.
 *
 * oxlint's no-unsafe-type-assertion finds them, but it also reports every assertion that
 * narrows a type, and it has no option to report only the ones from `any`. So this runs it
 * alone and drops the narrowing reports by their message. Every other report fails, so a
 * message that a newer oxlint words differently fails too, and is not let through.
 * ESLint does the same for the .vue files (eslint.config.js). `npm run lint` runs it.
 */
import { spawnSync } from "node:child_process";

/** The reports of an assertion that narrows a type that is not `any`. */
const NARROWING = [/ is more narrow than the original type\.$/, / could be instantiated with /];

type Diagnostic = { message: string; filename: string; labels: { span: { line: number; column: number } }[] };

const run = spawnSync(
	"node_modules/.bin/oxlint",
	// sandbox/pyodide is a Deno program, whose types tsgolint cannot read (.oxlintrc.json).
	["-A", "all", "-D", "typescript/no-unsafe-type-assertion", "--ignore-pattern", "sandbox/pyodide/**", "-f", "json"],
	{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (run.error || !run.stdout.startsWith("{")) {
	console.error(run.error ?? run.stderr);
	process.exit(1);
}

const found = diagnosticsIn(run.stdout).filter((diagnostic) => !NARROWING.some((pattern) => pattern.test(diagnostic.message)));
for (const { filename, labels, message } of found) {
	const { line, column } = labels[0]?.span ?? { line: 0, column: 0 };
	console.error(`${filename}:${line}:${column}: ${message}`);
}
if (found.length > 0) {
	console.error(`${found.length} type assertion(s) from \`any\`. Give the value the type \`unknown\` and narrow or decode it.`);
	process.exit(1);
}

function diagnosticsIn(json: string): Diagnostic[] {
	const output: unknown = JSON.parse(json);
	if (typeof output !== "object" || output === null || !("diagnostics" in output) || !Array.isArray(output.diagnostics)) {
		throw new Error("oxlint's JSON output has no diagnostics.");
	}
	// oxlint's own output, in the shape of its JSON format.
	return output.diagnostics as Diagnostic[];
}
