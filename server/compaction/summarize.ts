import { randomBytes } from "node:crypto";
import { APICallError, generateText, type UIMessage } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { isAuto } from "../../shared/auto-model.ts";
import * as AutoRouter from "../models/AutoRouter.ts";
import * as Models from "../models/Models.ts";
import { privateRouting } from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import type { UnreadableSecret } from "../secrets/Secrets.ts";
import * as Settings from "../settings/Settings.ts";
import { COMPACTION_FUNCTION_ID } from "../telemetry/Runs.ts";
import { runTelemetry, type RunContext } from "../telemetry/Telemetry.ts";
import { SUMMARY_INSTRUCTIONS, summaryPrompt } from "./prompt.ts";
import { budgetFor, DEFAULT_RATIO, estimateTokens } from "./tokens.ts";
import { clipMiddle, renderTranscript } from "./transcript.ts";

/**
 * Writes a chat's summary with the model admins chose (settings/Settings.ts), through a private
 * (ZDR) endpoint like every other call. The call goes to `runs` as "compaction", and is
 * charged to the person's credits, as memory and web search are.
 *
 * The chat's own model writes it instead when the chosen one is not available, or its
 * window is too small for the transcript.
 */
const MAX_OUTPUT_TOKENS = 16_000;
/** A summary longer than this is cut in the middle, never summarized again: a smaller tail does not make it smaller. */
const MAX_SUMMARY_CHARS = 48_000;
/** A summarizer that has not answered by then failed: compactStep tries again, then leaves the old messages out. */
const TIMEOUT = "3 minutes";

/**
 * The summary could not be written. compactStep tries again, and on its last attempt
 * leaves the old messages out instead (compaction.ts). The model and the HTTP status,
 * never the provider's answer or the chat.
 */
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("SummaryFailed", {
	model: Schema.String,
	/** "empty": no text; "length": cut off by the output limit; "timeout": no answer in time; "call": the call failed. */
	reason: Schema.Literals(["empty", "length", "timeout", "call"]),
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		switch (this.reason) {
			case "empty":
				return `${this.model} wrote an empty summary`;
			case "length":
				return `${this.model} ran out of room for the summary`;
			case "timeout":
				// AbortSignal.timeout's words, as the summarizer's timeout said before.
				return "The operation was aborted due to timeout";
			case "call":
				return `${this.model} could not write the summary${this.status === undefined ? "" : ` (HTTP ${this.status})`}`;
		}
	}
}

export type SummaryInput = {
	run: RunContext;
	chatModel: string;
	/** The summary these messages come after, if any. */
	previous: string | undefined;
	messages: UIMessage[];
	/** The thread's measured ratio; the default when it is higher, since another model reads the transcript. */
	ratio: number;
};

export type SummaryError = SummaryFailed | OpenRouterKey.NoOpenRouterKey | UnreadableSecret | AutoRouter.NoPrivateModel | SqlError;

export class Summarizer extends Context.Service<
	Summarizer,
	{
		/** The summary of `messages`, after `previous`, and the model that wrote it. */
		readonly write: (input: SummaryInput) => Effect.Effect<{ text: string; model: string }, SummaryError>;
	}
>()("ponder/compaction/Summarizer") {}

const make = Effect.gen(function* () {
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const router = yield* AutoRouter.AutoRouter;
	const models = yield* Models.Models;
	const settings = yield* Settings.Settings;

	/** The tokens one call to `model` may take: 90% of its window. */
	const roomFor = (model: string) => Effect.map(router.modelWindow(model), (window) => budgetFor(Option.getOrUndefined(window)).limit);

	/** The chosen model when it is available and has room for `needed` tokens; else the chat's model. */
	const summaryModel = Effect.fnUntraced(function* (chatModel: string, needed: number) {
		const chosen = (yield* settings.get).compactionModel;
		if (chosen === chatModel) return chatModel;
		if (!(yield* models.privateModels).some((model) => model.id === chosen)) return chatModel;
		return (yield* roomFor(chosen)) >= needed ? chosen : chatModel;
	});

	// No span of its own: compaction.run is its span, and the AI SDK's call nests under it.
	const write = Effect.fnUntraced(function* ({ run, chatModel, previous, messages, ratio }: SummaryInput) {
		const nonce = randomBytes(6).toString("hex");
		const corrected = (text: string) => Math.ceil(Math.max(ratio, DEFAULT_RATIO) * estimateTokens(text));
		const full = renderTranscript(messages, Number.POSITIVE_INFINITY, nonce);
		const needed = corrected(summaryPrompt(previous, full, nonce)) + corrected(SUMMARY_INSTRUCTIONS) + MAX_OUTPUT_TOKENS;
		const model = yield* summaryModel(chatModel, needed);
		const limit = yield* roomFor(model);
		// Over the room, the oldest messages are cut first. The previous summary never is.
		const room = Math.floor((limit - MAX_OUTPUT_TOKENS - corrected(SUMMARY_INSTRUCTIONS) - corrected(summaryPrompt(previous, "", nonce))) / Math.max(ratio, DEFAULT_RATIO));
		const transcript = needed <= limit ? full : renderTranscript(messages, room, nonce);
		const openRouter = yield* keys.provider;
		const plugins = isAuto(model) ? { plugins: [yield* router.plugin] } : {};
		const { text, finishReason } = yield* Effect.tryPromise({
			// Interrupting the effect, or its timeout, aborts the call.
			try: (signal) =>
				generateText({
					model: openRouter(model, { usage: { include: true }, provider: privateRouting, ...plugins }),
					instructions: SUMMARY_INSTRUCTIONS,
					prompt: summaryPrompt(previous, transcript, nonce),
					maxOutputTokens: MAX_OUTPUT_TOKENS,
					abortSignal: signal,
					...runTelemetry(run, COMPACTION_FUNCTION_ID),
				}),
			catch: (cause) => new SummaryFailed({ model, reason: "call", status: APICallError.isInstance(cause) ? cause.statusCode : undefined, cause }),
		}).pipe(Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new SummaryFailed({ model, reason: "timeout" })) }));
		if (!text.trim()) return yield* new SummaryFailed({ model, reason: "empty" });
		// A summary cut off by the output limit ends mid-sentence, and can drop what the person asked last.
		if (finishReason === "length") return yield* new SummaryFailed({ model, reason: "length" });
		return { text: clipMiddle(text.trim(), MAX_SUMMARY_CHARS), model };
	});

	return Summarizer.of({ write });
});

export const layer = Layer.effect(Summarizer, make);
