/**
 * The model call that reads a page, against a fake OpenRouter: an HttpClient that answers
 * in the test. Checks what is sent, and what the record keeps.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as PonderConfig from "../../config.ts";
import * as OpenRouter from "../../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../../openrouter/OpenRouterKey.ts";
import * as PageReader from "./page-reader.ts";
import { parseJson } from "../../test-json.ts";

type Sent = { url: string; authorization: string | undefined; body: Record<string, unknown> };
type Answer = { status: number; body: unknown };

const PDF = new TextEncoder().encode("%PDF-1.7 one page");
const PAGE_TEXT = "| Drug | Dose |\n| --- | --- |\n| Cefazolin | 15 mg/kg daily |";

/** A fake OpenRouter that gives the answers in order, and the requests it got. */
function fakeOpenRouter(answers: Answer[]) {
	const sent: Sent[] = [];
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) =>
		Effect.sync(() => {
			const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
			sent.push({ url: url.href, authorization: request.headers.authorization, body: parseJson<Sent["body"]>(text) });
			const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
			return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(answer.body), { status: answer.status }));
		}),
	);
	const key = OpenRouterKey.OpenRouterKey.of({
		key: Effect.succeed("sk-test"),
		provider: Effect.die("not used"),
		status: Effect.die("not used"),
		check: () => Effect.die("not used"),
		save: () => Effect.die("not used"),
	});
	const layer = PageReader.layer.pipe(
		Layer.provide(Layer.mergeAll(OpenRouter.layer, Layer.succeed(OpenRouterKey.OpenRouterKey, key))),
		Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), PonderConfig.layerFromEnv({ OPENROUTER_BASE_URL: "http://openrouter.test/api" }))),
	);
	return { sent, layer };
}

const completion = { id: "gen-123", model: "google/gemini-3.8-flash-001", choices: [{ finish_reason: "stop", message: { content: PAGE_TEXT } }], usage: { cost: 0.0021, prompt_tokens: 1800, completion_tokens: 140, completion_tokens_details: { reasoning_tokens: 30 } } };
const read = (reason: "picture" | "scan" = "picture") => PageReader.PageReader.use((reader) => reader.read({ page: 251, reason, pdf: PDF }));

describe("PageReader", () => {
	it.effect("sends one page as a PDF file to Gemini, on private endpoints, with the tuned prompt", () => {
		const fake = fakeOpenRouter([{ status: 200, body: completion }]);
		return Effect.gen(function* () {
			yield* read();
			assert.strictEqual(fake.sent.length, 1);
			const [request] = fake.sent;
			assert.strictEqual(request.url, "http://openrouter.test/api/v1/chat/completions");
			assert.strictEqual(request.authorization, "Bearer sk-test");
			assert.deepInclude(request.body, {
				model: "google/gemini-3.8-flash",
				provider: { zdr: true, data_collection: "deny" },
				reasoning: { effort: "low" },
				temperature: 0,
				usage: { include: true },
				plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
			});
			assert.deepStrictEqual(request.body.messages, [
				{
					role: "user",
					content: [
						{ type: "text", text: PageReader.PAGE_PROMPT },
						{ type: "file", file: { filename: "page-251.pdf", file_data: `data:application/pdf;base64,${Buffer.from(PDF).toString("base64")}` } },
					],
				},
			]);
			assert.match(PageReader.PAGE_PROMPT, /^Transcribe this document page into Markdown, in reading order\./);
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("gives the text, and a record with the cost, tokens and generation id but no text", () => {
		const fake = fakeOpenRouter([{ status: 200, body: completion }]);
		return Effect.gen(function* () {
			const result = yield* read("scan");
			assert.deepStrictEqual(result.text, Option.some(PAGE_TEXT));
			const { ms, ...record } = result.record;
			assert.isAtLeast(ms, 0);
			assert.deepStrictEqual(record, {
				page: 251,
				reason: "scan",
				model: "google/gemini-3.8-flash-001",
				ok: true,
				error: null,
				attempts: 1,
				costUsd: 0.0021,
				inputTokens: 1800,
				outputTokens: 140,
				reasoningTokens: 30,
				generationId: "gen-123",
				calls: [{ generationId: "gen-123", costUsd: 0.0021, inputTokens: 1800, outputTokens: 140 }],
				chars: PAGE_TEXT.length,
			});
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("records a refusal with OpenRouter's error cut to 300 characters, and does not try again", () => {
		const fake = fakeOpenRouter([{ status: 400, body: { error: { message: `Bad request: ${"x".repeat(400)}` } } }]);
		return Effect.gen(function* () {
			const result = yield* read();
			assert.isTrue(Option.isNone(result.text));
			assert.strictEqual(result.record.ok, false);
			assert.strictEqual(result.record.attempts, 1);
			assert.strictEqual(result.record.error?.length, 300);
			assert.isTrue(result.record.error?.startsWith("Bad request: xxx"));
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("tries again after a provider failure, and adds up the attempts", () => {
		const fake = fakeOpenRouter([
			{ status: 503, body: { error: { message: "Provider returned error" } } },
			{ status: 200, body: completion },
		]);
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(read());
			yield* TestClock.adjust("2 seconds");
			const result = yield* Fiber.join(fiber);
			assert.strictEqual(fake.sent.length, 2);
			assert.strictEqual(result.record.ok, true);
			assert.strictEqual(result.record.attempts, 2);
			assert.strictEqual(result.record.costUsd, 0.0021);
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("keeps each answered try with its own generation id and cost, for costs that come late", () => {
		const noCost = { ...completion, id: "gen-1", usage: { prompt_tokens: 1800, completion_tokens: 0 } };
		const fake = fakeOpenRouter([
			{ status: 200, body: { ...noCost, choices: [{ finish_reason: "stop", message: { content: "" } }] } },
			{ status: 503, body: { error: { message: "Provider returned error" } } },
			{ status: 200, body: completion },
		]);
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(read());
			yield* TestClock.adjust("2 seconds");
			yield* TestClock.adjust("4 seconds");
			const result = yield* Fiber.join(fiber);
			assert.strictEqual(result.record.attempts, 3);
			// The 503 has no id, no cost and no tokens: OpenRouter did not take it.
			assert.deepStrictEqual(result.record.calls, [
				{ generationId: "gen-1", costUsd: null, inputTokens: 1800, outputTokens: 0 },
				{ generationId: "gen-123", costUsd: 0.0021, inputTokens: 1800, outputTokens: 140 },
			]);
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("fails an answer cut at the length limit, so a picture page keeps its own text", () => {
		const cut = { ...completion, choices: [{ finish_reason: "length", message: { content: "| Drug | Dose |" } }] };
		const fake = fakeOpenRouter([{ status: 200, body: cut }]);
		return Effect.gen(function* () {
			const result = yield* read();
			assert.isTrue(Option.isNone(result.text));
			assert.strictEqual(result.record.error, "The answer was longer than 8000 tokens.");
			// The tokens were spent: the cost is kept.
			assert.strictEqual(result.record.costUsd, 0.0021);
		}).pipe(Effect.provide(fake.layer));
	});
});
