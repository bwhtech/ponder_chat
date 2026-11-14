/**
 * Checks for what the model reads of a thread (workflow/context.ts, workflow/cache.ts) and
 * the per-person limits (rate-limit.ts). No database, no network:
 *   npx tsx server/context.check.ts
 */
import assert from "node:assert/strict";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
import { RateLimit } from "./rate-limit.ts";
import { withCacheMarks } from "./workflow/cache.ts";
import { addRecalledMemory, dropOtherModelsReasoning, trimOldToolResults } from "./workflow/context.ts";

const long = "x".repeat(5_000);
const toolTurn = (id: string): ModelMessage[] => [
	{ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "web_fetch", input: {} }] },
	{ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "web_fetch", output: { type: "json", value: { text: long } } }] },
];
const thread: ModelMessage[] = [
	{ role: "user", content: "first" },
	...toolTurn("a"),
	{ role: "assistant", content: "answer" },
	{ role: "user", content: [{ type: "text", text: "second" }] },
	...toolTurn("b"),
	{ role: "assistant", content: "answer" },
	{ role: "user", content: "third" },
	...toolTurn("c"),
];

// Turns older than the last two have their long results cut; the last two keep them whole.
const trimmed = trimOldToolResults(thread);
const resultOf = (message: ModelMessage) => (message.role === "tool" && message.content[0].type === "tool-result" ? message.content[0].output : undefined);
const old = resultOf(trimmed[2]);
assert.ok(old?.type === "text" && old.value.length < 1_300 && old.value.includes("Trimmed"));
assert.deepEqual(resultOf(trimmed[6]), resultOf(thread[6]));
assert.deepEqual(resultOf(trimmed[10]), resultOf(thread[10]));
// Two turns or fewer: nothing is cut.
assert.deepEqual(trimOldToolResults(thread.slice(0, 7)), thread.slice(0, 7));
// The same thread trims the same way on the next call, so the cached start is unchanged.
assert.deepEqual(trimOldToolResults(thread), trimmed);

// Recalled memory goes with the latest message only, not in the earlier ones.
const withMemory = addRecalledMemory(thread, "1. [fact] likes tea");
assert.deepEqual(withMemory.slice(0, 8), thread.slice(0, 8));
const latest = withMemory[8];
assert.ok(latest.role === "user" && Array.isArray(latest.content) && latest.content[0].type === "text" && latest.content[0].text.includes("likes tea"));
assert.equal(addRecalledMemory(thread, ""), thread);

// Cache marks: the instructions, the last person or tool message before the two kept turns and before the latest turn, and the last message.
const text = (value: string) => [{ type: "text" as const, text: value }];
const call = (id: string) => ({ role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: id, toolName: "web_fetch", input: {} }] });
const results = (...ids: string[]) => ({
	role: "tool" as const,
	content: ids.map((id) => ({ type: "tool-result" as const, toolCallId: id, toolName: "web_fetch", output: { type: "text" as const, value: "page" } })),
});
const prompt: LanguageModelV4Prompt = [
	{ role: "system", content: "instructions" },
	{ role: "user", content: text("first") },
	call("a"),
	results("a"),
	{ role: "assistant", content: text("answer") },
	{ role: "user", content: text("second") },
	{ role: "assistant", content: text("answer") },
	{ role: "user", content: text("third") },
	call("b"),
	results("b", "c"),
];
const isMarked = (value: { providerOptions?: Record<string, unknown> }) => Boolean(value.providerOptions?.openrouter);
const marksOf = (messages: LanguageModelV4Prompt) =>
	withCacheMarks(messages).flatMap((message, index) => [
		...(isMarked(message) ? [index] : []),
		...(message.role === "tool" ? message.content.filter(isMarked).map(() => index) : []),
	]);
assert.deepEqual(marksOf(prompt), [0, 3, 5, 9]);
// Only one result of a tool message carries the mark: a mark per result would pass Anthropic's four.
assert.deepEqual(withCacheMarks(prompt)[9].content.map((part) => isMarked(part as { providerOptions?: Record<string, unknown> })), [false, true]);
// Two turns: nothing is trimmed yet, so only the end of the first turn is marked.
assert.deepEqual(marksOf(prompt.slice(0, 6)), [0, 3, 5]);
assert.deepEqual(marksOf([prompt[1]]), [0]);

// Reasoning: kept for the model that wrote it, dropped after a switch, kept when the writer is unknown.
const reasoned = (id: string, model?: string): UIMessage => ({
	id,
	role: "assistant",
	...(model && { metadata: { model } }),
	parts: [
		{ type: "reasoning", text: "", providerMetadata: { openrouter: { reasoning_details: [] } } },
		{ type: "text", text: "answer" },
	],
});
const switched = dropOtherModelsReasoning(
	[{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }, reasoned("a", "anthropic/claude-haiku-5.5"), reasoned("b", "deepseek/deepseek-v4.1-flash"), reasoned("c")],
	"deepseek/deepseek-v4.1-flash",
);
assert.deepEqual(
	switched.map((message) => message.parts.map((part) => part.type)),
	[["text"], ["text"], ["reasoning", "text"], ["reasoning", "text"]],
);
// Under Auto the next model is not known, so even Auto's own replies drop their reasoning.
const underAuto = dropOtherModelsReasoning([reasoned("a", "openrouter/auto"), reasoned("b", "anthropic/claude-haiku-5.5"), reasoned("c")], "openrouter/auto");
assert.deepEqual(
	underAuto.map((message) => message.parts.map((part) => part.type)),
	[["text"], ["text"], ["reasoning", "text"]],
);

// Rate limits: the windows, the wait, and other people unaffected.
const limit = new RateLimit([{ max: 2, ms: 60_000 }]);
assert.equal(limit.take("ana", 0), 0);
assert.equal(limit.take("ana", 1_000), 0);
assert.equal(limit.take("ana", 2_000), 58);
assert.equal(limit.take("ben", 2_000), 0);
assert.equal(limit.take("ana", 60_001), 0);

console.log("context checks passed");
