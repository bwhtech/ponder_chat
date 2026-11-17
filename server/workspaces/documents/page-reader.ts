import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as OpenRouter from "../../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../../openrouter/OpenRouterKey.ts";
import { requestProblem } from "../../runtime/Http.ts";
import { sqlMessage } from "../../runtime/Database.ts";
import * as Tracing from "../../tracing/Tracing.ts";
import { cutError, type PageRead, type PageReadReason } from "./document.ts";

/**
 * Reads one PDF page with a model, for the pages that LiteParse cannot read: a table or a
 * chart that is a picture, or a scan. One page per call, sent as a one-page PDF.
 *
 * Gemini 3.8 Flash read the 31-row dose table of a real manual exactly, and had 0.6%
 * character error on scans, photos and Kannada (docs/workspaces-plan.md, "PDF reading").
 * The prompt was tuned on real pages: change it only with the test questions.
 */
export const PAGE_MODEL = "google/gemini-3.8-flash";

export const PAGE_PROMPT =
	"Transcribe this document page into Markdown, in reading order. Skip the repeated page header and footer boxes. " +
	"Write tables as Markdown tables, keeping every row, column, number, unit and footnote mark exactly as printed. " +
	"Write plain text: no LaTeX or math notation; use Unicode for symbols such as µ, ≥ and –. " +
	'For a chart, write its title, then the values you can read as a Markdown table, under the line "Values read from the chart (approximate):". ' +
	"For a diagram or flowchart, write its text as a nested list that follows the arrows. " +
	"Do not summarize, explain, correct or add anything. Output only the transcription.";

const TIMEOUT = Duration.minutes(3);
const MAX_ATTEMPTS = 3;
// A dense table page is about 3,000 tokens. A longer answer is a model that repeats itself.
const MAX_TOKENS = 8_000;

export type PageRequest = { page: number; reason: PageReadReason; pdf: Uint8Array };

/** The record, always; the text only when the call worked. */
export type PageReadResult = { record: PageRead; text: Option.Option<string> };

export class PageReader extends Context.Service<
	PageReader,
	{
		/** Reads one page. Never fails: a failed call is a record with `ok: false`. */
		readonly read: (request: PageRequest) => Effect.Effect<PageReadResult>;
	}
>()("ponder/workspaces/PageReader") {}

/** Lenient: a field OpenRouter leaves out, or sends as null, changes nothing. */
const text = Schema.optional(Schema.NullOr(Schema.String));
const count = Schema.optional(Schema.NullOr(Schema.Number));
const Completion = Schema.Struct({
	id: text,
	model: text,
	error: Schema.optional(Schema.NullOr(Schema.Struct({ message: text }))),
	choices: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ finish_reason: text, message: Schema.optional(Schema.NullOr(Schema.Struct({ content: text }))) })))),
	usage: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				cost: count,
				prompt_tokens: count,
				completion_tokens: count,
				completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ reasoning_tokens: count }))),
			}),
		),
	),
});
type Completion = typeof Completion.Type;
const decodeCompletion = Schema.decodeUnknownOption(Completion);

type Usage = { costUsd: number | null; inputTokens: number; outputTokens: number; reasoningTokens: number; generationId: string | null; model: string | null };
type Attempt = ({ ok: true; text: string } | { ok: false; error: string; retryable: boolean }) & Usage;

const NO_USAGE: Usage = { costUsd: null, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, generationId: null, model: null };

const make = Effect.gen(function* () {
	const openRouter = yield* OpenRouter.OpenRouter;
	const keys = yield* OpenRouterKey.OpenRouterKey;
	const client = yield* HttpClient.HttpClient;
	const endpoint = openRouter.url("v1/chat/completions");

	// Per attempt: the span is read's (workspace.page-read).
	const attempt = Effect.fnUntraced(function* (request: PageRequest) {
		const key = yield* keys.key.pipe(
			Effect.catchTags({
				NoOpenRouterKey: (error) => Effect.fail(error.message),
				UnreadableSecret: (error) => Effect.fail(error.message),
				SqlError: (error) => Effect.fail(sqlMessage(error)),
			}),
			Effect.result,
		);
		if (key._tag === "Failure") return failed(key.failure, false);
		const httpRequest = HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bearerToken(key.success), HttpClientRequest.bodyJsonUnsafe(requestBody(request)));
		// The timeout covers the answer and the reading of its body.
		const answer = yield* Effect.gen(function* () {
			const response = yield* client.execute(httpRequest);
			const json = yield* response.json.pipe(Effect.option);
			return { status: response.status, body: Option.getOrElse(Option.flatMap(json, decodeCompletion), (): Completion => ({})) };
		}).pipe(Effect.timeout(TIMEOUT), Effect.result);
		if (answer._tag === "Failure") return failed(requestProblem(answer.failure), true);
		return attemptOf(answer.success.status, answer.success.body);
	});

	// One span for each page, under the indexing run's workspace.parse (docs/workspaces-plan.md, "Indexing log").
	const read = Effect.fn("workspace.page-read")(function* (request: PageRequest) {
		const started = yield* Clock.currentTimeMillis;
		const attempts: Attempt[] = [];
		for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
			if (tries > 0) yield* Effect.sleep(Duration.seconds(2 ** tries));
			const result = yield* attempt(request);
			attempts.push(result);
			if (result.ok || !result.retryable) break;
		}
		const done = resultOf(request, attempts, (yield* Clock.currentTimeMillis) - started);
		yield* Tracing.annotate({ "ponder.page": request.page, "ponder.attempts": attempts.length, "ponder.chars": done.record.chars, "ponder.ok": done.record.ok });
		return done;
	});

	return PageReader.of({ read });
});

/** Gemini through OpenRouter, on Zero Data Retention endpoints. Its calls are paid by the system (`workspace-pdf` in `runs`). */
export const layer = Layer.effect(PageReader, make);

/** The body of one call: the prompt, then the page as a PDF file. */
function requestBody(request: PageRequest) {
	const file = `data:application/pdf;base64,${Buffer.from(request.pdf).toString("base64")}`;
	return {
		model: PAGE_MODEL,
		messages: [{ role: "user", content: [{ type: "text", text: PAGE_PROMPT }, { type: "file", file: { filename: `page-${request.page}.pdf`, file_data: file } }] }],
		provider: OpenRouter.privateRoutingBody,
		reasoning: { effort: "low" },
		temperature: 0,
		max_tokens: MAX_TOKENS,
		usage: { include: true },
		plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
	};
}

function attemptOf(status: number, body: Completion): Attempt {
	const usage = usageOf(body);
	const choice = body.choices?.[0];
	const content = choice?.message?.content?.trim() ?? "";
	if (status < 200 || status >= 300 || body.error) {
		// An error in a 200 answer is the provider's, after OpenRouter took the call: worth another try.
		const retryable = status === 408 || status === 429 || status >= 500 || status < 300;
		return { ...usage, ok: false, error: body.error?.message ?? `HTTP ${status}`, retryable };
	}
	if (choice?.finish_reason === "length") return { ...usage, ok: false, error: `The answer was longer than ${MAX_TOKENS} tokens.`, retryable: false };
	if (!content) return { ...usage, ok: false, error: "The model gave no text.", retryable: true };
	return { ...usage, ok: true, text: content };
}

function usageOf(body: Completion): Usage {
	return {
		costUsd: body.usage?.cost ?? null,
		inputTokens: body.usage?.prompt_tokens ?? 0,
		outputTokens: body.usage?.completion_tokens ?? 0,
		reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
		generationId: body.id ?? null,
		model: body.model ?? null,
	};
}

function failed(error: string, retryable: boolean): Attempt {
	return { ...NO_USAGE, ok: false, error, retryable };
}

/** One record for all attempts: their costs and tokens added up, the last one's id and outcome. */
function resultOf(request: PageRequest, attempts: Attempt[], ms: number): PageReadResult {
	const last = attempts[attempts.length - 1];
	const costs = attempts.flatMap((one) => (one.costUsd === null ? [] : [one.costUsd]));
	const sum = (pick: (one: Attempt) => number) => attempts.reduce((total, one) => total + pick(one), 0);
	const record: PageRead = {
		page: request.page,
		reason: request.reason,
		model: last.model ?? PAGE_MODEL,
		ok: last.ok,
		error: last.ok ? null : cutError(last.error),
		ms,
		attempts: attempts.length,
		costUsd: costs.length ? costs.reduce((total, cost) => total + cost, 0) : null,
		inputTokens: sum((one) => one.inputTokens),
		outputTokens: sum((one) => one.outputTokens),
		reasoningTokens: sum((one) => one.reasoningTokens),
		generationId: attempts.flatMap((one) => (one.generationId ? [one.generationId] : [])).at(-1) ?? null,
		chars: last.ok ? last.text.length : 0,
	};
	return { record, text: last.ok ? Option.some(last.text) : Option.none() };
}
