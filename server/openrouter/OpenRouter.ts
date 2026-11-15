import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as PonderConfig from "../config.ts";
import { requestProblem } from "../runtime/Http.ts";

/**
 * Privacy for every OpenRouter call: route only to Zero Data Retention endpoints, so
 * no provider keeps or trains on what people write. `zdr` is the strict rule (no
 * prompt or reply is kept); `data_collection: "deny"` also excludes any provider that
 * may store data. OpenRouter refuses the call when a model has no such endpoint.
 *
 * Not covered: OpenRouter's own tools, such as the PDF parser (workflow/model.ts).
 * OpenRouter's ZDR rule filters model endpoints only.
 */
const PRIVATE = { zdr: true, data_collection: "deny" } as const;

/** The `provider` setting for @openrouter/ai-sdk-provider, whose types do not list `zdr` yet. */
export const privateRouting = PRIVATE as unknown as { data_collection: "deny" };

/** The same, for requests sent to OpenRouter's API directly. */
export const privateRoutingBody = PRIVATE;

/**
 * Providers that hold back a tool call and send it whole at the end; replies skip them.
 * Wafer sent nothing for 17 seconds while it wrote a slide deck, then all of it in 1.5
 * seconds, so the page could not show the deck as it was written. Each model on our list
 * has other private endpoints, so none is left without one.
 */
export const HELD_BACK_TOOL_CALLS = ["wafer"];

const REFRESH_MS = 60 * 60 * 1000;

// OpenRouter's public list. Only model_id is needed; the rest may be missing or null.
const ZdrEndpoint = Schema.Struct({
	model_id: Schema.String,
	provider_name: Schema.optional(Schema.NullOr(Schema.String)),
	tag: Schema.optional(Schema.NullOr(Schema.String)),
	context_length: Schema.optional(Schema.NullOr(Schema.Number)),
});
type ZdrEndpoint = typeof ZdrEndpoint.Type;
const ZdrAnswer = Schema.Struct({ data: Schema.optional(Schema.NullOr(Schema.Array(ZdrEndpoint))) });

type ZdrList = { ids: ReadonlySet<string>; windows: ReadonlyMap<string, number>; at: number };

export class OpenRouter extends Context.Service<
	OpenRouter,
	{
		/**
		 * An OpenRouter API address, such as url("v1/chat/completions"). OPENROUTER_BASE_URL
		 * points every call at another server, such as the fake OpenRouter that the end-to-end
		 * tests run (e2e/fake/), so they need no key and spend nothing.
		 */
		readonly url: (path: string) => string;
		/**
		 * The models with at least one ZDR endpoint, from OpenRouter's public list, read at
		 * most once an hour. None when the list can't be read: the caller decides.
		 */
		readonly modelsWithZdr: Effect.Effect<Option.Option<ReadonlySet<string>>>;
		/**
		 * The same list, but only as far as it is known now: never waits for OpenRouter.
		 * None before the first read (just after a start). An old list starts a new read.
		 */
		readonly modelsWithZdrNow: Effect.Effect<Option.Option<ReadonlySet<string>>>;
		/**
		 * A model's context window in tokens: the smallest among its ZDR endpoints that replies
		 * use, since OpenRouter may route a call to any of them. None when it is not known.
		 */
		readonly contextWindow: (modelId: string) => Effect.Effect<Option.Option<number>>;
	}
>()("ponder/openrouter/OpenRouter") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const client = yield* HttpClient.HttpClient;
	// The reads of the list run in the layer's scope, so a caller that stops waiting does not stop them.
	const scope = yield* Effect.scope;

	const url = (path: string) => `${config.openRouterBaseUrl}/${path}`;
	const zdrEndpoints = url("v1/endpoints/zdr");

	const list = yield* Ref.make(Option.none<ZdrList>());
	const reading = yield* Ref.make(Option.none<Deferred.Deferred<Option.Option<ZdrList>>>());

	/** One read of the list. A failure is logged, and the list known before stays. */
	const readZdrList = client.get(zdrEndpoints).pipe(
		Effect.flatMap(HttpClientResponse.filterStatusOk),
		Effect.flatMap(HttpClientResponse.schemaBodyJson(ZdrAnswer)),
		Effect.timeout("5 seconds"),
		Effect.flatMap((answer) =>
			Effect.gen(function* () {
				const endpoints = answer.data ?? [];
				const read: ZdrList = { ids: new Set(endpoints.map((endpoint) => endpoint.model_id)), windows: smallestWindows(endpoints), at: yield* Clock.currentTimeMillis };
				yield* Ref.set(list, Option.some(read));
				return Option.some(read);
			}),
		),
		Effect.catch((error) => Effect.logWarning("OpenRouter ZDR list:", requestProblem(error)).pipe(Effect.andThen(Ref.get(list)))),
	);

	/** The read in progress, or a new one. One read at a time. */
	const startReading = Effect.gen(function* () {
		const next = yield* Deferred.make<Option.Option<ZdrList>>();
		type Reading = Option.Option<Deferred.Deferred<Option.Option<ZdrList>>>;
		const [pending, mine] = yield* Ref.modify(reading, (current): [[Deferred.Deferred<Option.Option<ZdrList>>, boolean], Reading] =>
			Option.isSome(current) ? [[current.value, false], current] : [[next, true], Option.some(next)],
		);
		if (mine) yield* readZdrList.pipe(Deferred.into(next), Effect.ensuring(Ref.set(reading, Option.none())), Effect.forkIn(scope));
		return pending;
	});

	/**
	 * The list, read again once it is an hour old. Until the new read ends, the old list
	 * answers: only the first request after a start waits for OpenRouter (GET /api/models
	 * took 160 ms at the median when each hour's first request waited). One read at a time.
	 */
	const zdrList = Effect.gen(function* () {
		const known = yield* Ref.get(list);
		if (yield* fresh(known)) return known;
		const pending = yield* startReading;
		return Option.isSome(known) ? known : yield* Deferred.await(pending);
	});

	const fresh = (known: Option.Option<ZdrList>) =>
		Effect.map(Clock.currentTimeMillis, (now) => Option.isSome(known) && now - known.value.at < REFRESH_MS);

	const modelsWithZdr = Effect.map(zdrList, Option.map((read) => read.ids));

	const modelsWithZdrNow = Effect.gen(function* () {
		const known = yield* Ref.get(list);
		if (!(yield* fresh(known))) yield* startReading;
		return Option.map(known, (read) => read.ids);
	});

	const contextWindow = (modelId: string) => Effect.map(zdrList, Option.flatMap((read) => Option.fromUndefinedOr(read.windows.get(modelId))));

	return OpenRouter.of({ url, modelsWithZdr, modelsWithZdrNow, contextWindow });
});

export const layer = Layer.effect(OpenRouter, make);

function smallestWindows(endpoints: ReadonlyArray<ZdrEndpoint>) {
	const windows = new Map<string, number>();
	for (const endpoint of endpoints) {
		if (!(endpoint.context_length && endpoint.context_length > 0) || heldBack(endpoint)) continue;
		const known = windows.get(endpoint.model_id);
		windows.set(endpoint.model_id, known ? Math.min(known, endpoint.context_length) : endpoint.context_length);
	}
	return windows;
}

function heldBack(endpoint: ZdrEndpoint) {
	const names = [endpoint.provider_name, endpoint.tag?.split("/")[0]].map((name) => name?.toLowerCase());
	return HELD_BACK_TOOL_CALLS.some((slug) => names.includes(slug));
}
