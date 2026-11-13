import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { asSchema, type ModelMessage, type ToolResultPart, type ToolSet } from "ai";
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal";
import type { CompactRequest } from "../compaction/compact.ts";
import { budgetFor, estimateTokens, measuredRatio, type Budget } from "../compaction/tokens.ts";
import { trimResult } from "./context.ts";
import { compactStep } from "./steps.ts";
import type { ThreadContext } from "./thread-messages.ts";

/**
 * Keeps each model call of a reply inside the model's context window (server/compaction/).
 *
 * - Before the first call, a history over the trigger is summarized (compactStep).
 * - Between steps, the count is the last call's measured input tokens plus an estimate
 *   of what was added since, as in eve. Over the trigger, everything before the current
 *   turn is summarized. If the turn alone is still over, the long tool results of its
 *   earlier steps are cut, as for older turns (context.ts).
 *
 * Workflow code: every decision reads recorded step results only, so a replay decides
 * the same, and the summarizer runs in a step, so a replay never runs it twice.
 */
export class ContextOverLimitError extends Error {
	override name = "ContextOverLimitError";
}

type Base = Pick<CompactRequest, "threadId" | "owner" | "modelId" | "recalled" | "skills" | "connectors">;
type StepInfo = { stepNumber: number; steps: { usage: { inputTokens?: number | undefined } }[]; messages: LanguageModelV4Prompt };

export class ContextGuard {
	/** Ponder's estimate of the call about to be made, for recordUsageStep. */
	estimate = 0;
	private budget: Budget;
	private ratio: number;
	/** How many prompt messages the last estimate counted. */
	private seen = 0;
	private turnCompacted = false;

	constructor(
		private base: Base,
		private context: ThreadContext,
		private toolTokens: number,
		private writable: WritableStream<ModelCallStreamPart>,
		private modelName: string,
	) {
		this.budget = budgetFor(context.window);
		this.ratio = context.ratio;
	}

	/** The messages for the first call: the thread, summarized first when it is over the trigger. */
	async initialMessages(instructions: string): Promise<ModelMessage[]> {
		const envelope = estimateTokens(instructions) + this.toolTokens;
		const tokens = this.ratio * (this.context.tokens + envelope);
		if (tokens <= this.budget.trigger) return this.context.messages;
		const result = await compactStep(this.writable, this.request("start", envelope));
		if (result.kind === "compacted" || result.kind === "left-out") return result.messages;
		if (result.kind === "over-limit" || tokens > this.budget.limit) throw this.tooLong("message");
		return this.context.messages;
	}

	/** For WorkflowAgent's prepareStep: the messages it returns replace the prompt for this step and the next. */
	prepareStep = async ({ stepNumber, steps, messages }: StepInfo): Promise<{ messages: LanguageModelV4Prompt } | undefined> => {
		const prompt = stepNumber > 0 ? await this.keepInside(messages, steps.at(-1)?.usage.inputTokens ?? 0) : messages;
		this.estimate = estimateTokens(prompt) + this.toolTokens;
		this.seen = prompt.length;
		return prompt === messages ? undefined : { messages: prompt };
	};

	private async keepInside(messages: LanguageModelV4Prompt, measured: number) {
		this.ratio = measuredRatio(measured, this.estimate) ?? this.ratio;
		const tokens = measured > 0 ? measured + this.ratio * estimateTokens(messages.slice(this.seen)) : this.count(messages);
		if (tokens <= this.budget.trigger) return messages;
		let prompt = await this.compactTurn(messages);
		if (this.count(prompt) > this.budget.trigger) prompt = trimEarlierSteps(prompt);
		if (this.count(prompt) > this.budget.limit) throw this.tooLong("reply");
		return prompt;
	}

	/** Summarizes everything before the current turn, once a reply. */
	private async compactTurn(messages: LanguageModelV4Prompt): Promise<LanguageModelV4Prompt> {
		if (this.turnCompacted) return messages;
		this.turnCompacted = true;
		const system = messages.findIndex((message) => message.role !== "system");
		const turn = messages.map((message) => message.role).lastIndexOf("user");
		if (system < 0 || turn < system) return messages;
		const envelope = estimateTokens(messages.slice(0, system)) + this.toolTokens;
		const result = await compactStep(this.writable, { ...this.request("turn", envelope), turnTokens: estimateTokens(messages.slice(turn)) });
		if (result.kind !== "compacted" && result.kind !== "left-out") return messages;
		return [...messages.slice(0, system), ...(await providerMessages(result.messages)), ...messages.slice(turn)];
	}

	private count(prompt: LanguageModelV4Prompt) {
		return this.ratio * (estimateTokens(prompt) + this.toolTokens);
	}

	private request(mode: CompactRequest["mode"], envelope: number): CompactRequest {
		return { ...this.base, ratio: this.ratio, window: this.context.window, envelope, mode };
	}

	private tooLong(what: "message" | "reply") {
		return new ContextOverLimitError(
			what === "message"
				? `This message is too long for ${this.modelName}. Shorten it, or attach the text as a file.`
				: `This reply grew too long for ${this.modelName}: its tool results don't fit. Ask for less at a time, or choose a model with a longer context.`,
		);
	}
}

/** The estimated tokens of the tools' names, descriptions and input schemas. */
export async function toolTokens(tools: ToolSet) {
	const specs = await Promise.all(
		Object.entries(tools).map(async ([name, tool]) => ({ name, description: tool.description, schema: tool.inputSchema ? await asSchema(tool.inputSchema).jsonSchema : {} })),
	);
	return estimateTokens(specs);
}

/** Model messages in the provider's format, as WorkflowAgent converts its own. */
async function providerMessages(messages: ModelMessage[]): Promise<LanguageModelV4Prompt> {
	const prompt = await standardizePrompt({ messages });
	return convertToLanguageModelPrompt({ prompt, supportedUrls: {}, download: async (requests) => requests.map(() => null) });
}

/** Cuts the long tool results of the current turn's earlier steps; the last step's stay whole. */
function trimEarlierSteps(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
	const roles = prompt.map((message) => message.role);
	const turn = roles.lastIndexOf("user");
	const lastTool = roles.lastIndexOf("tool");
	return prompt.map((message, index) => {
		if (message.role !== "tool" || index < turn || index === lastTool) return message;
		const content = message.content.map((part) => (part.type === "tool-result" ? (trimResult(part as unknown as ToolResultPart) as unknown as typeof part) : part));
		return { ...message, content };
	});
}
