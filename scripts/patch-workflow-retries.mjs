// Lets WorkflowAgent's model-call steps run again after the server stops in the middle of one.
//
// @ai-sdk/workflow sets `maxRetries = 0` on its model steps (doStreamStep, doGenerateStep),
// so a crash or a deploy during a model call fails the whole reply. The step already
// starts each attempt with a `reset-step` chunk, which tells the browser to drop the
// partial output, so a retry is safe to show. Model errors are still retried inside the
// step by the AI SDK; this adds 2 attempts for a step whose server went away.
//
// Runs after `npm install` (package.json "postinstall"). Fails if the code it changes is
// gone, so an upgrade of @ai-sdk/workflow cannot drop this without anyone noticing.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const file = require.resolve("@ai-sdk/workflow").replace(/index\.(c?js)$/, "index.js");
const RETRIES = 2;
let source = readFileSync(file, "utf8");
for (const step of ["doStreamStep", "doGenerateStep"]) {
	const patched = `${step}.maxRetries = ${RETRIES};`;
	if (source.includes(patched)) continue;
	const original = new RegExp(`^${step}\\.maxRetries = 0;$`, "m");
	if (!original.test(source)) throw new Error(`patch-workflow-retries: "${step}.maxRetries = 0;" is not in ${file}. Check the new @ai-sdk/workflow before you change this patch.`);
	source = source.replace(original, patched);
}
writeFileSync(file, source);
console.log(`patch-workflow-retries: model steps retry ${RETRIES} times (${file})`);
