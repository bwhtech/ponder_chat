/**
 * The web app's browser-only typecheck (web/browser-check/tsconfig.json): vue-tsc with the
 * browser's types and the API's declarations, but not Node's. It also fails when Node's
 * types get into that program some other way, through a package's types, since then the
 * check would let Node's globals through without a word. `npm run typecheck` runs it after
 * `npm run api-types`.
 */
import { spawnSync } from "node:child_process";

const NODE_TYPES = "/node_modules/@types/node/";

const run = spawnSync(
	process.execPath,
	["scripts/vue-tsc.cjs", "--noEmit", "--listFiles", "-p", "web/browser-check/tsconfig.json"],
	{ encoding: "utf8" },
);
const lines = run.stdout.split("\n");
const errors = lines.filter((line) => !line.startsWith("/"));
const nodeTypes = lines.filter((line) => line.includes(NODE_TYPES));

process.stderr.write(run.stderr);
if (errors.some((line) => line.trim() !== "")) console.error(errors.join("\n"));
if (nodeTypes.length > 0) {
	console.error(`Node's types got into the web app's browser-only program, for example ${nodeTypes[0]}.`);
	console.error("Find what brings them: npx tsc -p web/browser-check/tsconfig.json --explainFiles");
}
if (run.status !== 0 || nodeTypes.length > 0) process.exit(1);
