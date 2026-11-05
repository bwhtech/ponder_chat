import { AsyncLocalStorage } from "node:async_hooks";
import type { StepResult, Telemetry, ToolSet } from "ai";
import { insertRun, type RunRow, type ToolCallRecord } from "./store.ts";

type Step = StepResult<ToolSet>;

type RunState = {
	parentId: string | null;
	threadId: string | null;
	user: string | null;
	functionId: string | null;
	model: string;
	startedAt: number;
	steps: Step[];
	toolRuns: Map<string, { name: string; ok: boolean; ms: number }>;
};

const TEXT_OPERATIONS = new Set(["ai.streamText", "ai.generateText"]);

/**
 * Telemetry integration that writes one `runs` row per text generation. It reads only usage,
 * tool names, timings and the runtime context that telemetry may see; never prompts or outputs.
 */
export class RunRecorder implements Telemetry {
	private runs = new Map<string, RunState>();
	// The run whose tool is executing, so a subagent call inside a tool links to its parent.
	private parentRun = new AsyncLocalStorage<string>();

	onStart(event: { callId: string; operationId: string; modelId?: string; runtimeContext?: unknown; functionId?: string }) {
		if (!TEXT_OPERATIONS.has(event.operationId)) return;
		const parentId = this.parentRun.getStore() ?? null;
		const parent = parentId ? this.runs.get(parentId) : undefined;
		const context = (event.runtimeContext ?? {}) as { threadId?: string; user?: string };
		this.runs.set(event.callId, {
			parentId,
			threadId: context.threadId ?? parent?.threadId ?? null,
			user: context.user ?? parent?.user ?? null,
			functionId: event.functionId ?? null,
			model: event.modelId ?? "unknown",
			startedAt: Date.now(),
			steps: [],
			toolRuns: new Map(),
		});
	}

	onStepEnd(event: Step) {
		this.runs.get(event.callId)?.steps.push(event);
	}

	onToolExecutionEnd(event: {
		callId: string;
		toolExecutionMs: number;
		toolCall: { toolCallId: string; toolName: string };
		toolOutput: { type: string };
	}) {
		const { toolCallId, toolName } = event.toolCall;
		const ok = event.toolOutput.type === "tool-result";
		this.runs.get(event.callId)?.toolRuns.set(toolCallId, { name: toolName, ok, ms: Math.round(event.toolExecutionMs) });
	}

	executeTool<T>({ callId, execute }: { callId: string; execute: () => PromiseLike<T> }) {
		return this.parentRun.run(callId, () => Promise.resolve(execute()));
	}

	async onEnd(event: { callId: string }) {
		await this.finish(event.callId, (run) => run.steps.at(-1)?.finishReason ?? "unknown");
	}

	async onAbort(event: { callId: string }) {
		await this.finish(event.callId, () => "aborted");
	}

	async onError(event: unknown) {
		const { callId } = (event ?? {}) as { callId?: string };
		if (callId) await this.finish(callId, () => "error");
	}

	private async finish(callId: string, finishReason: (run: RunState) => string) {
		const run = this.runs.get(callId);
		if (!run) return;
		this.runs.delete(callId);
		try {
			await insertRun(toRow(callId, run, finishReason(run)));
		} catch (error) {
			// Never log the row or the error's query text: keep it to the cause.
			console.error(`telemetry: could not save run ${callId}:`, (error as Error).message);
		}
	}
}

function toRow(id: string, run: RunState, finishReason: string): RunRow {
	const sum = (pick: (step: Step) => number | undefined) => run.steps.reduce((total, step) => total + (pick(step) ?? 0), 0);
	const costs = run.steps.map(stepCost).filter((cost) => cost != null);
	return {
		id,
		parentId: run.parentId,
		threadId: run.threadId,
		user: run.user,
		functionId: run.functionId,
		model: run.steps.at(-1)?.response?.modelId ?? run.model,
		steps: run.steps.length,
		inputTokens: sum((step) => step.usage.inputTokens),
		outputTokens: sum((step) => step.usage.outputTokens),
		cachedTokens: sum((step) => step.usage.inputTokenDetails?.cacheReadTokens),
		costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
		durationMs: Date.now() - run.startedAt,
		toolCalls: toolCalls(run),
		finishReason,
	};
}

/** OpenRouter reports the cost of each call in USD, in provider metadata and in the raw usage. */
function stepCost(step: Step): number | undefined {
	const metadata = step.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
	const raw = step.usage.raw as { cost?: number } | undefined;
	return metadata?.usage?.cost ?? raw?.cost;
}

/**
 * The calls the model made in this run, then the calls it made in an earlier run that ran now,
 * such as a write the person approved.
 */
function toolCalls(run: RunState): ToolCallRecord[] {
	const records = new Map<string, ToolCallRecord>();
	for (const call of run.steps.flatMap((step) => step.toolCalls)) {
		records.set(call.toolCallId, { name: call.toolName, status: "pending" });
	}
	for (const [toolCallId, { name, ok, ms }] of run.toolRuns) {
		records.set(toolCallId, { name, status: ok ? "ok" : "error", ms });
	}
	return [...records.values()];
}
