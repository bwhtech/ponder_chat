/**
 * Checks for the reply loop (loop.ts): the retry policy of model calls (model-errors.ts),
 * the stream parts the model step writes (stream-parts.ts), tool calls (tool-calls.ts)
 * and approvals (approvals.ts). No database, no network:
 *   npx tsx server/workflow/loop.check.ts
 */
import assert from "node:assert/strict";
import { toUIMessageChunk } from "@ai-sdk/workflow";
import { APICallError, convertToModelMessages, generateText, InvalidPromptError, isStepCount, jsonSchema, NoOutputGeneratedError, simulateReadableStream, streamText, tool, type ModelMessage, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { answeredApprovals, signApproval, verifyApproval, withoutApprovals } from "./approvals.ts";
import { answersIn, openAnswersSettled, settledChunks, stillAsked, UNCERTAIN, withUncertainOutcomes } from "./answered-again.ts";
import { THREAD_CHANGED } from "../../shared/replies.ts";
import { approvedIn } from "./connector-messages.ts";
import { connectorTools } from "./connectors.ts";
import { classifyModelError, MODEL_CALL_ATTEMPTS, ModelStalledError } from "./model-errors.ts";
import { storedPart, toolCallOf } from "./stream-parts.ts";
import { outcomeParts, toolMessage, ToolCalls, toolSpans } from "./tool-calls.ts";

const noJitter = () => 0;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const model = (chunks: unknown[]) => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: chunks as never[] }) }) });
const apiError = (statusCode: number, headers?: Record<string, string>) =>
	new APICallError({ message: `status ${statusCode}`, url: "u", requestBodyValues: {}, statusCode, responseHeaders: headers });

// --- Retry policy -------------------------------------------------------------

const verdict = (error: unknown, attempt = 1) => classifyModelError(error, attempt, noJitter);
// Errors another attempt can fix: rate limits, server errors, network, stalls, broken streams.
for (const status of [408, 409, 429, 500, 502, 503, 529]) assert.equal(verdict(apiError(status)).retry, true, `status ${status}`);
assert.equal(verdict(Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) })).retry, true);
assert.equal(verdict(new Error("terminated")).retry, true);
assert.equal(verdict(new ModelStalledError("silent")).retry, true);
assert.equal(verdict({ code: 502, message: "Provider returned error" }).retry, true, "OpenRouter's error chunk in the middle of a stream");
assert.equal(verdict(Object.assign(new Error("No output generated."), { name: "AI_NoOutputGeneratedError" })).retry, true);
// The server's own errors too, such as a stream write after a deploy closed the database.
assert.equal(verdict(Object.assign(new Error("Failed query: insert into workflow_stream_chunks"), { cause: { code: "CONNECTION_ENDED" } })).retry, true);
// A model that refused the request would refuse again: the request, the key, OpenRouter credit, a missing model.
for (const status of [400, 401, 402, 403, 404, 413, 422]) assert.equal(verdict(apiError(status)).retry, false, `status ${status}`);
assert.equal(verdict({ code: 400, message: "Context too long" }).retry, false, "a refusal in the stream");
assert.equal(verdict(new Error("wrapped", { cause: apiError(401) })).retry, false);
// The AI SDK's own errors with no HTTP status would fail again, except a stream that broke or came back empty.
assert.equal(verdict(new InvalidPromptError({ prompt: "", message: "The prompt is not valid." })).retry, false);
assert.equal(verdict(new NoOutputGeneratedError()).retry, true);
assert.equal(verdict(new APICallError({ message: "fetch failed", url: "u", requestBodyValues: {}, isRetryable: true })).retry, true, "a network failure has no status");
// At most MODEL_CALL_ATTEMPTS attempts.
assert.equal(verdict(apiError(503), MODEL_CALL_ATTEMPTS).retry, false);
// Backoff: 2 s, then 8 s, plus jitter of up to 1 s; a 429's Retry-After wins, up to 30 s.
assert.deepEqual(verdict(apiError(503), 1), { retry: true, afterMs: 2_000, reason: "status 503" });
assert.deepEqual(verdict(apiError(503), 2), { retry: true, afterMs: 8_000, reason: "status 503" });
assert.equal((classifyModelError(apiError(503), 1, () => 0.999) as { afterMs: number }).afterMs, 2_999);
assert.equal((verdict(apiError(429, { "retry-after": "12" })) as { afterMs: number }).afterMs, 12_000);
assert.equal((verdict(apiError(429, { "retry-after": "600" })) as { afterMs: number }).afterMs, 30_000);

// --- Stream parts -------------------------------------------------------------

// What the model step writes gives the page the same UI chunks as WorkflowAgent's stream did.
const streamed = streamText({
	model: model([
		{ type: "response-metadata", id: "gen-1" },
		{ type: "reasoning-start", id: "r" },
		{ type: "reasoning-delta", id: "r", delta: "Thinking" },
		{ type: "reasoning-end", id: "r" },
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: "Here it is." },
		{ type: "text-end", id: "t" },
		{ type: "tool-input-start", id: "c1", toolName: "write_artifact" },
		{ type: "tool-input-delta", id: "c1", delta: '{"title":"Pl' },
		{ type: "tool-input-delta", id: "c1", delta: 'an"}' },
		{ type: "tool-input-end", id: "c1" },
		{ type: "tool-call", toolCallId: "c1", toolName: "write_artifact", input: '{"title":"Plan"}' },
		{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
	]),
	messages: [{ role: "user", content: "Write a plan" }],
	tools: { write_artifact: tool({ inputSchema: jsonSchema({ type: "object" }) }) },
	stopWhen: isStepCount(1),
});
const stored = [];
for await (const part of streamed.fullStream) {
	const kept = storedPart(part);
	if (kept) stored.push(kept);
}
assert.deepEqual(
	stored.map((part) => toUIMessageChunk(part)?.type),
	["reasoning-start", "reasoning-delta", "reasoning-end", "text-start", "text-delta", "text-end", "tool-input-start", "tool-input-delta", "tool-input-delta", "tool-input-available"],
);
assert.deepEqual(toUIMessageChunk(stored[7]), { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"title":"Pl' }, "artifacts stream as the model writes them");
assert.deepEqual(toUIMessageChunk(stored[9]), { type: "tool-input-available", toolCallId: "c1", toolName: "write_artifact", input: { title: "Plan" } });
// The stream is serialized, so every part is plain data.
assert.deepEqual(structuredClone(stored), stored);

// --- Tool calls ---------------------------------------------------------------

const calls = new ToolCalls({
	lookup: tool({ inputSchema: z.object({ q: z.string() }), execute: async ({ q }) => ({ found: q }) }),
	broken: tool({ inputSchema: z.object({}), execute: async (): Promise<string> => Promise.reject(new Error("The sandbox is down.")) }),
	fetch_page: tool({ inputSchema: z.object({ url: z.string() }), needsApproval: (input) => !input.url.startsWith("https://trusted."), execute: async () => "page" }),
	note: tool({ inputSchema: z.object({}), execute: async () => "noted" }),
});
const call = (toolCallId: string, toolName: string, input: unknown) => ({ type: "tool-call" as const, toolCallId, toolName, input });
const specs = await calls.specs();
assert.deepEqual(specs.find((spec) => spec.name === "lookup")?.inputSchema.required, ["q"]);
assert.equal(await calls.needsApproval(call("a", "fetch_page", { url: "https://other.example" }), []), true);
assert.equal(await calls.needsApproval(call("a", "fetch_page", { url: "https://trusted.example" }), []), false);
assert.equal(await calls.needsApproval(call("a", "lookup", { q: "x" }), []), false);
assert.equal(calls.canApprove("fetch_page"), true);
assert.equal(calls.canApprove("note"), false, "a tool that never asks can't be approved");
// Calls run in parallel; a failure, a wrong input or an unknown tool becomes a result the model reads.
const outcomes = await calls.run([call("1", "lookup", { q: "moons" }), call("2", "broken", {}), call("3", "lookup", { wrong: 1 }), call("4", "nope", {})], []);
assert.deepEqual(
	outcomes.map(({ output, failed }) => [failed, typeof output === "string" ? output.slice(0, 26) : output]),
	[
		[false, { found: "moons" }],
		[true, "The sandbox is down."],
		[true, "Invalid input for lookup: "],
		[true, "There is no tool named nop"],
	],
);
assert.deepEqual(
	outcomeParts(outcomes.slice(0, 2)).map((part) => toUIMessageChunk(part)),
	[
		{ type: "tool-output-available", toolCallId: "1", output: { found: "moons" } },
		{ type: "tool-output-error", toolCallId: "2", errorText: "The sandbox is down." },
	],
);
const [results] = toolMessage(outcomes.slice(0, 2), [call("5", "fetch_page", { url: "x" })]);
assert.deepEqual(results.role === "tool" && results.content.map((part) => part.type === "tool-result" && part.output.type), ["json", "error-text", "execution-denied"]);

// An invalid call (an unknown tool, or input cut by the output limit) never runs, and the
// model reads one result for each call: the SDK's own results are left out.
const lookups: unknown[] = [];
const loopTools = { lookup: tool({ inputSchema: z.object({ q: z.string() }), execute: async (input) => (lookups.push(input), "found") }) };
const invalidStream = streamText({
	model: model([
		{ type: "tool-call", toolCallId: "u1", toolName: "no_such_tool", input: "{}" },
		{ type: "tool-call", toolCallId: "u2", toolName: "lookup", input: '{"q":"cut' },
		{ type: "tool-call", toolCallId: "u3", toolName: "lookup", input: '{"q":"ok"}' },
		{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
	]),
	messages: [{ role: "user", content: "Look it up" }],
	tools: { lookup: tool({ inputSchema: jsonSchema({ type: "object" }) }) },
	stopWhen: isStepCount(1),
	onError: () => {},
});
const streamedCalls = [];
const invalidParts = [];
for await (const part of invalidStream.fullStream) {
	if (part.type === "tool-call") streamedCalls.push(toolCallOf(part));
	const kept = storedPart(part);
	if (kept) invalidParts.push(toUIMessageChunk(kept)?.type);
}
assert.deepEqual(invalidParts, ["tool-input-error", "tool-input-error", "tool-input-available"], "the page shows the invalid calls as input errors");
assert.match(streamedCalls[0].invalid ?? "", /unavailable tool 'no_such_tool'/);
assert.match(streamedCalls[1].invalid ?? "", /JSON parsing failed/);
assert.equal(streamedCalls[2].invalid, undefined);
const loopCalls = new ToolCalls(loopTools);
assert.equal(await loopCalls.needsApproval(streamedCalls[1], []), false);
const loopOutcomes = await loopCalls.run(streamedCalls, []);
assert.deepEqual(lookups, [{ q: "ok" }], "only the valid call ran");
assert.deepEqual(
	outcomeParts(loopOutcomes).map((part) => toUIMessageChunk(part)),
	[{ type: "tool-output-available", toolCallId: "u3", output: "found" }],
	"the page gets no second result for an invalid call",
);
const assistant = (await invalidStream.response).messages.filter((message) => message.role === "assistant");
const conversation: ModelMessage[] = [...assistant, ...toolMessage(loopOutcomes)];
const resultIds = conversation.flatMap((message) => (message.role === "tool" ? message.content.map((part) => part.type === "tool-result" && part.toolCallId) : []));
assert.deepEqual(resultIds, ["u1", "u2", "u3"], "one result for each call");
// Only the call that ran has an execute_tool span.
assert.deepEqual(
	toolSpans(loopOutcomes).map(({ name, callId, failed }) => [name, callId, failed]),
	[["lookup", "u3", false]],
);
// An approved call that was refused, such as for a signature that is not valid, did not run either.
const refusedCall = { type: "tool-call" as const, toolCallId: "r1", toolName: "lookup", input: {} };
assert.deepEqual(toolSpans([{ call: refusedCall, output: "The approval is not valid, so the call did not run.", failed: false, refused: true, start: 1, end: 1 }]), []);
assert.equal(outcomeParts([{ call: refusedCall, output: "not valid", failed: false, refused: true, start: 1, end: 1 }]).length, 1, "the page still shows why");

// --- Approvals ----------------------------------------------------------------

const secret = "check-secret";
// Our signature is the AI SDK's: an approval asked before the deploy still verifies after it.
const asked = await generateText({
	model: new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "tool-call", toolCallId: "call-1", toolName: "fetch_page", input: '{"url":"https://example.org/a","b":[1,{"z":2,"a":1}]}' }],
			finishReason: { unified: "tool-calls", raw: "tool_calls" },
			usage,
			warnings: [],
		}),
	}),
	prompt: "Read it",
	tools: { fetch_page: tool({ inputSchema: jsonSchema({ type: "object" }), needsApproval: true, execute: async () => "page" }) },
	experimental_toolApprovalSecret: secret,
});
const request = asked.content.find((part) => part.type === "tool-approval-request");
assert.ok(request?.signature, "the AI SDK signed the request");
assert.equal(
	await signApproval(secret, { approvalId: request.approvalId, toolCallId: "call-1", toolName: "fetch_page", input: { url: "https://example.org/a", b: [1, { z: 2, a: 1 }] } }),
	request.signature,
);
// Checked in constant time: the AI SDK's signature passes, a changed or a short one fails.
const signedCall = { approvalId: request.approvalId, toolCallId: "call-1", toolName: "fetch_page", input: { url: "https://example.org/a", b: [1, { z: 2, a: 1 }] } };
assert.equal(await verifyApproval(secret, signedCall, request.signature), true);
assert.equal(await verifyApproval(secret, { ...signedCall, input: { url: "https://example.org/b" } }, request.signature), false);
assert.equal(await verifyApproval(secret, signedCall, request.signature.slice(0, 10)), false);
assert.equal(await verifyApproval("another-secret", signedCall, request.signature), false);

// The person's answers, as the page sends them back, come out of the messages in call order.
const answered: UIMessage[] = [
	{ id: "u", role: "user", parts: [{ type: "text", text: "Read both" }] },
	{
		id: "a",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-fetch_page", toolCallId: "c1", state: "approval-responded", input: { url: "one" }, approval: { id: "approval-c1", approved: true, signature: "sig-1" } } as never,
			{ type: "tool-fetch_page", toolCallId: "c2", state: "approval-responded", input: { url: "two" }, approval: { id: "approval-c2", approved: false, reason: "No" } } as never,
		],
	},
];
const messages = await convertToModelMessages(answered);
const { approved, denied } = answeredApprovals(messages);
assert.deepEqual(
	approved.map((approval) => [approval.call.toolCallId, approval.request.signature]),
	[["c1", "sig-1"]],
);
assert.deepEqual(
	denied.map((approval) => [approval.call.toolCallId, approval.answered]),
	[["c2", true]],
);
// The model reads the calls without the approval parts.
const cleaned = withoutApprovals(messages);
assert.ok(cleaned.every((message) => typeof message.content === "string" || message.content.every((part) => !part.type.startsWith("tool-approval"))));
// The denial's result stays, so the model reads that the person said no.
const last = cleaned.at(-1);
assert.deepEqual(last?.role === "tool" && last.content.map((part) => part.type === "tool-result" && [part.toolCallId, part.output.type]), [["c2", "execution-denied"]]);
// A call that already has its result is not carried out again.
const done = [...messages.slice(0, -1), { role: "tool" as const, content: [...(messages.at(-1)!.content as never[]), { type: "tool-result", toolCallId: "c1", toolName: "fetch_page", output: { type: "text", value: "page" } }] }];
assert.deepEqual(answeredApprovals(done as never).approved, []);

// An approved connector call runs with the messages that still hold its request and the
// person's answer, and with the input from that call, so connector_call's own check
// (approvedIn) finds the approval. A call the model just made has none.
const connectorAnswer: UIMessage[] = [
	{ id: "u2", role: "user", parts: [{ type: "text", text: "Add a note" }] },
	{
		id: "a2",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-connector_call", toolCallId: "k1", state: "approval-responded", input: { tool: "shop__add_note", input: { order: "A1", note: "Wrap" } }, approval: { id: "approval-k1", approved: true } } as never,
		],
	},
];
const connectorMessages = await convertToModelMessages(connectorAnswer);
const [connectorApproval] = answeredApprovals(connectorMessages).approved;
assert.equal(approvedIn(connectorMessages, "k1", connectorApproval.call.input), true);
assert.equal(approvedIn(withoutApprovals(connectorMessages), "k1", connectorApproval.call.input), false, "the loop must not drop the approval before the call");
const justMade: ModelMessage[] = [connectorMessages[0], { role: "assistant", content: [{ type: "tool-call", toolCallId: "k2", toolName: "connector_call", input: { tool: "shop__add_note", input: {} } }] }];
assert.equal(approvedIn(justMade, "k2", { tool: "shop__add_note", input: {} }), false);

// An answer is used once (replies.ts): it must answer a question that still waits in the
// saved message. A second tab, a resend, an old card after Stop or Retry answer nothing.
const toolPart = (toolCallId: string, state: string, extra: object = {}) =>
	({ type: "tool-connector_call", toolCallId, state, input: { tool: "shop__add_note", input: {} }, ...extra }) as never;
const approval = (id: string, approved = true) => ({ approval: { id, approved } });
const askedAgain: UIMessage = { id: "m1", role: "assistant", parts: [{ type: "step-start" }, toolPart("c1", "approval-responded", approval("approval-c1"))] };
const answers = answersIn(askedAgain);
assert.deepEqual(answers, [{ approvalId: "approval-c1", toolCallId: "c1", approved: true }]);
const waitingSaved: UIMessage = { id: "m1", role: "assistant", parts: [{ type: "step-start" }, toolPart("c1", "approval-requested", { approval: { id: "approval-c1" } })] };
assert.equal(stillAsked(waitingSaved, answers), true, "the first answer to a question that waits");
const doneSaved: UIMessage = {
	id: "m1",
	role: "assistant",
	parts: [{ type: "step-start" }, toolPart("c1", "output-available", { ...approval("approval-c1"), output: "Added the note." }), { type: "step-start" }, { type: "text", text: "Done." }],
};
assert.equal(stillAsked(doneSaved, answers), false, "a question answered and carried out");
const stoppedSaved: UIMessage = { id: "m1", role: "assistant", parts: [{ type: "step-start" }, toolPart("c1", "approval-responded", approval("approval-c1"))] };
assert.equal(stillAsked(stoppedSaved, answers), false, "a question answered, whose run Stop cut short");
assert.equal(stillAsked(undefined, answers), false, "a message that Retry replaced, a deleted chat, or another message id");
// The next question in the same message, asked by the run after the first answer, waits.
const askedNext: UIMessage = { id: "m1", role: "assistant", parts: [...doneSaved.parts, toolPart("c2", "approval-responded", approval("approval-c2"))] };
const savedNext: UIMessage = { id: "m1", role: "assistant", parts: [...doneSaved.parts, toolPart("c2", "approval-requested", { approval: { id: "approval-c2" } })] };
assert.deepEqual(answersIn(askedNext).map((answer) => answer.approvalId), ["approval-c2"], "a call with its result is no longer an answer");
assert.equal(stillAsked(savedNext, answersIn(askedNext)), true);
// A stopped call may or may not have taken effect: the saved message says so, and never runs it again.
const uncertain = withUncertainOutcomes(stoppedSaved, answers);
assert.deepEqual(uncertain?.parts[1], { ...(stoppedSaved.parts[1] as object), state: "output-error", errorText: UNCERTAIN });
assert.equal(withUncertainOutcomes(doneSaved, answers), undefined, "a call with its result keeps it");
// A stopped call earlier in the thread reads as uncertain, so the next message can go on; the last message's answers are left for the run.
const history = openAnswersSettled([stoppedSaved, { id: "u2", role: "user", parts: [{ type: "text", text: "Thanks" }] }]);
assert.equal((history[0].parts[1] as { state: string }).state, "output-error");
assert.deepEqual(openAnswersSettled([stoppedSaved]), [stoppedSaved]);
// The page gets each answer's outcome, so it sends nothing more, and loads the saved thread.
assert.deepEqual(settledChunks(doneSaved, askedAgain), [
	{ type: "start", messageId: "m1" },
	{ type: THREAD_CHANGED, data: {}, transient: true },
	{ type: "start-step" },
	{ type: "tool-output-available", toolCallId: "c1", output: "Added the note." },
	{ type: "finish-step" },
	{ type: "finish" },
]);
const deniedAgain: UIMessage = { id: "m1", role: "assistant", parts: [toolPart("c1", "approval-responded", approval("approval-c1", false))] };
assert.deepEqual(
	settledChunks(undefined, askedAgain).filter((chunk) => chunk.type.startsWith("tool-")),
	[{ type: "tool-output-error", toolCallId: "c1", errorText: UNCERTAIN }],
);
assert.deepEqual(
	settledChunks(undefined, deniedAgain).filter((chunk) => chunk.type.startsWith("tool-")),
	[{ type: "tool-output-denied", toolCallId: "c1" }],
);
// A call that was approved and already ran reads as not approved: on a later turn, the
// saved thread has the call's result after it, and convertToModelMessages keeps the approval.
const ranEarlier: UIMessage[] = [
	{ id: "u3", role: "user", parts: [{ type: "text", text: "Add a note" }] },
	{
		id: "a3",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-connector_call", toolCallId: "k1", state: "output-available", input: { tool: "shop__add_note", input: { order: "A1", note: "Wrap" } }, output: "Added the note.", approval: { id: "approval-k1", approved: true } } as never,
		],
	},
	{ id: "u4", role: "user", parts: [{ type: "text", text: "And again?" }] },
];
const ranMessages = await convertToModelMessages(ranEarlier);
assert.ok(JSON.stringify(ranMessages).includes("tool-approval-response"), "the approval is still in the converted messages");
assert.equal(approvedIn(ranMessages, "k1", { tool: "shop__add_note", input: { order: "A1", note: "Wrap" } }), false);
assert.deepEqual(answeredApprovals(ranMessages).approved, [], "the loop does not carry it out again");

// Through the tools the loop runs (ToolCalls): connector_call gets approved = true with the
// messages of a run that carries out the approval, and false with those of a later turn.
const seen: boolean[] = [];
const shopCatalog = {
	tools: [{ name: "shop__add_note", tool: "add_note", description: "Adds a note.", inputSchema: { type: "object" }, connector: { slug: "shop", name: "Shop" }, connectionId: "shop", ask: true, readOnly: false }],
	connectors: [{ slug: "shop", name: "Shop", tools: 1 }],
	leftOut: 0,
};
const connectorLoopTools = new ToolCalls(
	connectorTools(shopCatalog, "ana", async (_id, _tool, _input, _owner, wasApproved) => {
		seen.push(wasApproved);
		return "ran";
	}),
);
await connectorLoopTools.run([connectorApproval.call], connectorMessages);
const laterCall = ranMessages.flatMap((message) => (message.role === "assistant" && typeof message.content !== "string" ? message.content : [])).find((part) => part.type === "tool-call")!;
await connectorLoopTools.run([laterCall as never], ranMessages);
assert.deepEqual(seen, [true, false]);

console.log("loop.check: all checks passed");
