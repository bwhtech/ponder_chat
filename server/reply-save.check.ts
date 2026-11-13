/**
 * Checks for how a reply is saved (workflow/reply.ts): joining the stream's deltas
 * (workflow/join-deltas.ts) saves the same message, and a long reply in many small
 * pieces saves fast. The run's raw parts go through the same chunks and the same
 * readUIMessageStream as saveReply. No database, no network:
 *   npx tsx server/reply-save.check.ts
 */
import assert from "node:assert/strict";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { joinDeltas } from "./workflow/join-deltas.ts";
import { toUIChunks } from "./workflow/reply-chunks.ts";

/** What saveReply makes of these raw parts, with or without the join. */
async function saved(parts: object[], join: boolean): Promise<UIMessage | undefined> {
	const raw = new ReadableStream<ModelCallStreamPart>({
		start(controller) {
			for (const part of parts) controller.enqueue(part as ModelCallStreamPart);
			controller.close();
		},
	});
	const chunks = raw.pipeThrough(toUIChunks());
	const stream = join ? chunks.pipeThrough(joinDeltas()) : chunks;
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
/** A text or reasoning part in `count` deltas, with `metadata` on the deltas at the given places. */
const deltas = (kind: "text" | "reasoning", id: string, count: number, metadata: Record<number, object> = {}) => [
	{ type: `${kind}-start`, id },
	...Array.from({ length: count }, (_, i) => ({ type: `${kind}-delta`, id, text: `w${i} `, ...(metadata[i] && { providerMetadata: metadata[i] }) })),
	{ type: `${kind}-end`, id },
];

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

// --- Text and reasoning deltas join too. The SDK keeps a part's last providerMetadata that
// is set, so the joined delta brings the run's last one: on the first, a middle or the last delta.
{
	const meta = (n: number) => ({ fake: { n } });
	await same("text, no metadata", deltas("text", "t1", 50));
	await same("text, metadata on the first delta", deltas("text", "t1", 50, { 0: meta(1) }));
	await same("text, metadata on a middle delta", deltas("text", "t1", 50, { 25: meta(2) }));
	await same("text, metadata on the last delta", deltas("text", "t1", 50, { 49: meta(3) }));
	await same("text, metadata on several", deltas("text", "t1", 50, { 0: meta(1), 25: meta(2), 40: meta(4) }));
	await same("reasoning, metadata on a middle delta", [...deltas("reasoning", "r1", 50, { 10: meta(5) }), ...deltas("text", "t1", 20)]);
	// Stopped in the middle of a part: the text so far, and its metadata so far.
	await same("text, stopped", deltas("text", "t1", 50, { 10: meta(6), 30: meta(7) }).slice(0, 26));
	await same("reasoning, stopped", deltas("reasoning", "r1", 50, { 5: meta(8) }).slice(0, 40));
	// Two text parts open at once, their deltas alternating in runs: each run joins with its own part only.
	const t1 = deltas("text", "t1", 40, { 3: meta(10) });
	const t2 = deltas("text", "t2", 40, { 30: meta(11) });
	const mixed: object[] = [t1[0], t2[0]];
	for (let i = 1; i <= 40; i += 4) mixed.push(...t1.slice(i, i + 4), ...t2.slice(i, i + 4));
	await same("two text parts open at once", [...mixed, t1.at(-1)!, t2.at(-1)!]);
	// Two text parts, and text between tool inputs.
	const a = streamed("call-a", artifactInput(2_000));
	await same("text, tool input, text", [...deltas("text", "t1", 30), a.start, ...a.deltas, a.call, ...deltas("text", "t2", 30, { 29: meta(9) })]);
}

// --- Two inputs whose deltas alternate one by one, finished and stopped: each joins with its own.
{
	const a = streamed("call-a", artifactInput(3_000));
	const b = streamed("call-b", { ...artifactInput(2_500), id: "other" });
	const alternating = Array.from({ length: Math.max(a.deltas.length, b.deltas.length) }, (_, i) => [a.deltas[i], b.deltas[i]]).flat().filter(Boolean) as object[];
	await same("two inputs, one by one", [a.start, b.start, ...alternating, a.call, b.call]);
	await same("two inputs, one by one, stopped", [a.start, b.start, ...alternating.slice(0, 101)]);
}

// --- The end of the stream releases what is held (flush): a run of deltas that nothing follows.
{
	const ui = [
		{ type: "tool-input-start", toolCallId: "c1", toolName: "write_artifact" },
		{ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"a":' },
		{ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '"b"' },
	] as UIMessageChunk[];
	const out: UIMessageChunk[] = [];
	const source = new ReadableStream<UIMessageChunk>({
		start(controller) {
			for (const chunk of ui) controller.enqueue(chunk);
			controller.close();
		},
	});
	for await (const chunk of source.pipeThrough(joinDeltas())) out.push(chunk);
	assert.deepEqual(out, [ui[0], { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"a":"b"' }], "held deltas come out at the end");
	const textOut: UIMessageChunk[] = [];
	const textSource = new ReadableStream<UIMessageChunk>({
		start(controller) {
			controller.enqueue({ type: "text-start", id: "t1" });
			controller.enqueue({ type: "text-delta", id: "t1", delta: "One " });
			controller.enqueue({ type: "text-delta", id: "t1", delta: "two", providerMetadata: { fake: { n: 1 } } });
			controller.close();
		},
	});
	for await (const chunk of textSource.pipeThrough(joinDeltas())) textOut.push(chunk);
	assert.deepEqual(textOut, [{ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "One two", providerMetadata: { fake: { n: 1 } } }]);
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

// --- Speed: a 400 KB input, then 20,000 text deltas. The SDK clones the message at each chunk,
// input and all: unjoined, about 10 seconds.
{
	const a = streamed("call-a", artifactInput(400_000));
	const answer = deltas("text", "t2", 20_000);
	const started = performance.now();
	const message = await saved([a.start, ...a.deltas, a.call, ...answer], true);
	const took = performance.now() - started;
	assert.ok(message?.parts.some((part) => part.type === "text" && part.text.startsWith("w0 w1 ")));
	assert.ok(took < 1_000, `a 400 KB input and 20,000 text deltas saved in ${Math.round(took)} ms`);
	console.log(`a 400 KB input and 20,000 text deltas saved in ${Math.round(took)} ms`);
}

// --- Speed: two 100 KB inputs whose deltas alternate one by one. Joined only when consecutive: 3.6 seconds.
{
	const a = streamed("call-a", artifactInput(100_000));
	const b = streamed("call-b", { ...artifactInput(100_000), id: "other" });
	const alternating = Array.from({ length: Math.max(a.deltas.length, b.deltas.length) }, (_, i) => [a.deltas[i], b.deltas[i]]).flat().filter(Boolean) as object[];
	const started = performance.now();
	await saved([a.start, b.start, ...alternating, a.call, b.call], true);
	const took = performance.now() - started;
	assert.ok(took < 1_000, `two alternating 100 KB inputs saved in ${Math.round(took)} ms`);
	console.log(`two alternating 100 KB inputs saved in ${Math.round(took)} ms`);
}

console.log("reply save checks passed");
