/**
 * Checks for how a reply is saved (workflow/reply.ts): joining a tool call's input
 * deltas (joinToolInputDeltas) saves the same message, and a long input in many small
 * pieces saves fast. The run's raw parts go through the same chunks and the same
 * readUIMessageStream as saveReply. No database, no network:
 *   npx tsx server/reply-save.check.ts
 */
import assert from "node:assert/strict";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { readUIMessageStream, type UIMessage } from "ai";
import { joinToolInputDeltas, toUIChunks } from "./workflow/reply-chunks.ts";

/** What saveReply makes of these raw parts, with or without the join. */
async function saved(parts: object[], join: boolean): Promise<UIMessage | undefined> {
	const raw = new ReadableStream<ModelCallStreamPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(part as ModelCallStreamPart);
			controller.close();
		},
	});
	const chunks = raw.pipeThrough(toUIChunks());
	const stream = join ? chunks.pipeThrough(joinToolInputDeltas()) : chunks;
	let message: UIMessage | undefined;
	for await (const each of readUIMessageStream({ message: { id: "msg-1", role: "assistant", parts: [] }, stream })) message = each;
	return message;
}

const filler = (chars: number) => Array.from({ length: Math.ceil(chars / 5) }, (_, i) => `note${i % 97}`).join(" ").slice(0, chars);
const artifactInput = (chars: number) => ({ id: "notes", kind: "document", title: "Notes", content: filler(chars) });
/** A tool call's input as the model streams it: its start, then its JSON in pieces of `size` characters. */
const streamed = (id: string, input: object, size = 40) => {
	const json = JSON.stringify(input);
	const deltas = Array.from({ length: Math.ceil(json.length / size) }, (_, i) => ({ type: "tool-input-delta", id, delta: json.slice(i * size, (i + 1) * size) }));
	return { start: { type: "tool-input-start", id, toolName: "write_artifact" }, deltas, call: { type: "tool-call", toolCallId: id, toolName: "write_artifact", input } };
};
const text = (id: string, words: string[]) => [{ type: "text-start", id }, ...words.map((word) => ({ type: "text-delta", id, text: `${word} ` })), { type: "text-end", id }];

async function same(name: string, parts: object[]) {
	const plain = await saved(parts, false);
	const joined = await saved(parts, true);
	assert.ok(plain?.parts.length, `${name}: the check's stream saves something`);
	assert.deepEqual(joined, plain, name);
}

// A finished call's tool-call chunk sets its whole input, so only a stopped input shows the deltas.

// --- A finished input, with text before it and its result after.
{
	const a = streamed("call-a", artifactInput(6_000));
	await same("a finished input", [...text("t1", ["Writing", "it", "now."]), a.start, ...a.deltas, a.call, { type: "tool-result", toolCallId: "call-a", toolName: "write_artifact", output: "Saved." }]);
}

// --- An input cut off in the middle, as Stop saves it: the JSON so far, half a string.
{
	const a = streamed("call-a", artifactInput(6_000));
	await same("a stopped input", [a.start, ...a.deltas.slice(0, Math.floor(a.deltas.length / 2) + 1)]);
}

// --- Two calls whose inputs come interleaved, in runs of a few pieces each.
{
	const a = streamed("call-a", artifactInput(3_000));
	const b = streamed("call-b", { ...artifactInput(2_000), id: "other" });
	const interleaved: object[] = [];
	for (let i = 0; i < Math.max(a.deltas.length, b.deltas.length); i += 3) interleaved.push(...a.deltas.slice(i, i + 3), ...b.deltas.slice(i, i + 3));
	await same("two interleaved inputs", [a.start, b.start, ...interleaved, a.call, b.call]);
	// Stopped before either finished: the input each part keeps comes from its own deltas only.
	await same("two interleaved inputs, stopped", [a.start, b.start, ...interleaved.slice(0, Math.floor(interleaved.length / 2))]);
}

// --- A reset-step in the middle of an input: the model call was tried again, and the page drops the first attempt.
{
	const first = streamed("call-a", artifactInput(4_000));
	const second = streamed("call-a", { ...artifactInput(5_000), title: "Second" });
	await same("a reset-step in the middle", [first.start, ...first.deltas.slice(0, 40), { type: "reset-step" }, second.start, ...second.deltas, second.call]);
	await same("a reset-step in the middle, stopped", [first.start, ...first.deltas.slice(0, 40), { type: "reset-step" }, second.start, ...second.deltas.slice(0, 25)]);
}

// --- Speed: 10,000 pieces (400 KB) save in well under a second. Without the join, about 20 seconds.
{
	const a = streamed("call-a", artifactInput(400_000));
	assert.ok(a.deltas.length >= 10_000);
	const started = performance.now();
	const message = await saved([a.start, ...a.deltas, a.call], true);
	const took = performance.now() - started;
	assert.equal((message?.parts.find((part) => part.type === "tool-write_artifact") as { input?: { content?: string } }).input?.content?.length, 400_000);
	assert.ok(took < 1_000, `10,000 pieces saved in ${Math.round(took)} ms`);
	console.log(`10,000 pieces saved in ${Math.round(took)} ms`);
}

console.log("reply save checks passed");
