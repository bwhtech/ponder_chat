/**
 * The cost and usage of a run as telemetry records it: what credits are charged from for
 * the calls that are not a reply's (titles, memory, compaction). The AI SDK's events are
 * given by hand, and the row goes to the test instead of `runs`.
 */
import { assert, describe, it } from "@effect/vitest";
import type { StepResult, ToolSet } from "ai";
import { callCost } from "./cost.ts";
import { RunRecorder } from "./run-recorder.ts";
import type { RunRow } from "./Runs.ts";

type Step = StepResult<ToolSet>;

const step = (callId: string, part: { cost?: { metadata?: number; raw?: number }; input: number; output: number; cached?: number; toolCalls?: string[]; finishReason: string; modelId?: string }) =>
	({
		callId,
		finishReason: part.finishReason,
		usage: { inputTokens: part.input, outputTokens: part.output, inputTokenDetails: { cacheReadTokens: part.cached }, raw: part.cost?.raw === undefined ? undefined : { cost: part.cost.raw } },
		providerMetadata: part.cost?.metadata === undefined ? undefined : { openrouter: { usage: { cost: part.cost.metadata } } },
		toolCalls: (part.toolCalls ?? []).map((name) => ({ toolCallId: `${callId}-${name}`, toolName: name })),
		response: { modelId: part.modelId },
	}) as unknown as Step;

describe("callCost", () => {
	it("takes OpenRouter's cost from the provider metadata, else from the raw usage", () => {
		assert.strictEqual(callCost({ providerMetadata: { openrouter: { usage: { cost: 0.002 } } }, usage: { raw: { cost: 0.5 } } }), 0.002);
		assert.strictEqual(callCost({ usage: { raw: { cost: 0.5 } } }), 0.5);
		assert.strictEqual(callCost({ providerMetadata: { openrouter: { usage: { cost: 0 } } }, usage: {} }), 0);
		assert.isNull(callCost({ usage: {} }));
	});
});

describe("RunRecorder", () => {
	it("sums a run's steps into one row, with the tool calls and no content", async () => {
		const rows: RunRow[] = [];
		const recorder = new RunRecorder(async (row) => void rows.push(row));
		recorder.onStart({ callId: "c1", operationId: "ai.generateText", modelId: "openrouter/auto", runtimeContext: { threadId: "t1", user: "u1" }, functionId: "compaction" });
		recorder.onStepEnd(step("c1", { cost: { metadata: 0.001 }, input: 100, output: 10, cached: 40, toolCalls: ["web_search"], finishReason: "tool-calls" }));
		recorder.onToolExecutionEnd({ callId: "c1", toolExecutionMs: 12.6, toolCall: { toolCallId: "c1-web_search", toolName: "web_search" }, toolOutput: { type: "tool-result" } });
		recorder.onStepEnd(step("c1", { cost: { raw: 0.0025 }, input: 200, output: 20, toolCalls: ["connector_call"], finishReason: "stop", modelId: "z-ai/glm-5.3" }));
		await recorder.onEnd({ callId: "c1" });

		assert.strictEqual(rows.length, 1);
		const { durationMs, ...row } = rows[0]!;
		assert.isAtLeast(durationMs, 0);
		assert.deepStrictEqual(row, {
			id: "c1",
			parentId: null,
			threadId: "t1",
			user: "u1",
			functionId: "compaction",
			model: "z-ai/glm-5.3",
			steps: 2,
			inputTokens: 300,
			outputTokens: 30,
			cachedTokens: 40,
			costUsd: 0.0035,
			toolCalls: [
				{ name: "web_search", status: "ok", ms: 13 },
				{ name: "connector_call", status: "pending" },
			],
			finishReason: "stop",
		});
	});

	it("records no cost when OpenRouter reported none, and an aborted or failed run as such", async () => {
		const rows: RunRow[] = [];
		const recorder = new RunRecorder(async (row) => void rows.push(row));
		recorder.onStart({ callId: "c2", operationId: "ai.streamText", runtimeContext: {} });
		recorder.onStepEnd(step("c2", { input: 5, output: 1, finishReason: "stop" }));
		await recorder.onAbort({ callId: "c2" });
		recorder.onStart({ callId: "c3", operationId: "ai.streamText", modelId: "m" });
		await recorder.onError({ callId: "c3" });
		// Not a text generation: not recorded.
		recorder.onStart({ callId: "c4", operationId: "ai.embed" });
		await recorder.onEnd({ callId: "c4" });

		assert.deepStrictEqual(
			rows.map(({ id, costUsd, finishReason, model, threadId, steps }) => ({ id, costUsd, finishReason, model, threadId, steps })),
			[
				{ id: "c2", costUsd: null, finishReason: "aborted", model: "unknown", threadId: null, steps: 1 },
				{ id: "c3", costUsd: null, finishReason: "error", model: "m", threadId: null, steps: 0 },
			],
		);
	});

	it("gives a subagent's run the parent's thread and person", async () => {
		const rows: RunRow[] = [];
		const recorder = new RunRecorder(async (row) => void rows.push(row));
		recorder.onStart({ callId: "parent", operationId: "ai.streamText", runtimeContext: { threadId: "t9", user: "u9" } });
		await recorder.executeTool({
			callId: "parent",
			execute: async () => {
				recorder.onStart({ callId: "child", operationId: "ai.generateText" });
				await recorder.onEnd({ callId: "child" });
			},
		});
		assert.deepInclude(rows[0], { id: "child", parentId: "parent", threadId: "t9", user: "u9" });
	});
});
