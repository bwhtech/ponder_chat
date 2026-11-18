import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../../config.ts";
import * as OpenRouter from "../../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../../openrouter/OpenRouterKey.ts";
import * as PrepareText from "../documents/prepare-text.ts";
import * as Database from "../../runtime/Database.ts";
import * as Http from "../../runtime/Http.ts";
import * as Secrets from "../../secrets/Secrets.ts";
import type { PageRead } from "../documents/document.ts";
import * as PageReader from "../documents/page-reader.ts";

/**
 * The PDF reader's services for scripts (the eval, read-pdf.check.ts), without the whole
 * app's runtime.
 */

/** The real model, with the key the app uses: the one saved in /admin, else OPENROUTER_API_KEY. */
export const liveLayer = Layer.mergeAll(PageReader.layer, PrepareText.layer).pipe(
	Layer.provideMerge(OpenRouterKey.layer),
	Layer.provideMerge(Layer.mergeAll(OpenRouter.layer, Secrets.layer)),
	Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
	Layer.provideMerge(PonderConfig.layer),
);

/**
 * A model that answers from `texts` (page number to text), and fails for any other page:
 * a picture page then keeps LiteParse's text, and a page with no text fails the read.
 */
export const recordedLayer = (texts: ReadonlyMap<number, string>) =>
	Layer.mergeAll(Layer.succeed(PageReader.PageReader, PageReader.PageReader.of({ read: (request) => Effect.succeed(recordedRead(request, texts.get(request.page))) })), PrepareText.layer);

function recordedRead(request: PageReader.PageRequest, text: string | undefined): PageReader.PageReadResult {
	const record: PageRead = {
		page: request.page,
		reason: request.reason,
		model: "recorded",
		ok: text !== undefined,
		error: text === undefined ? "No model in this run." : null,
		ms: 0,
		attempts: 1,
		calls: [],
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		generationId: null,
		chars: text?.length ?? 0,
	};
	return { record, text: Option.fromUndefinedOr(text) };
}
