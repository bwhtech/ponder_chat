import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as PonderConfig from "../config.ts";
import * as Secrets from "../secrets/Secrets.ts";
import * as OpenRouter from "./OpenRouter.ts";

/**
 * The OpenRouter API key that every call uses: replies, thread names, memory, embeddings
 * and web search. Admins set it on /admin, Settings, where it is saved encrypted
 * (secrets/Secrets.ts). Until one is saved there, OPENROUTER_API_KEY from the environment is used.
 *
 * The decrypted key is kept in memory for a minute. A change from /admin applies at once
 * in this process.
 */
const NAME = "openrouter_api_key";
const CACHE_MS = 60_000;

/** No key is saved in /admin, and OPENROUTER_API_KEY is not set. */
export class NoOpenRouterKey extends Schema.TaggedError<NoOpenRouterKey>()("NoOpenRouterKey", {}) {
	override get message() {
		return "There is no OpenRouter key. An admin can add one in /admin, Settings.";
	}
}

export type KeyStatus = {
	/** Where the key in use comes from: Settings, the environment, or nowhere. */
	source: "settings" | "environment" | "none";
	/** The key's last characters, such as "…3f9a", so admins can tell keys apart. */
	hint: string | null;
	/** The saved key can't be decrypted, because BETTER_AUTH_SECRET changed. */
	unreadable: boolean;
	updatedAt: Date | null;
	updatedBy: string | null;
};

export class OpenRouterKey extends Context.Service<
	OpenRouterKey,
	{
		/** The key in use: the saved one, or else OPENROUTER_API_KEY. Kept for a minute. */
		readonly key: Effect.Effect<string, NoOpenRouterKey | Secrets.UnreadableSecret | SqlError>;
		/** An OpenRouter provider with the current key. Get one for each call, because the key can change. */
		readonly provider: Effect.Effect<OpenRouterProvider, NoOpenRouterKey | Secrets.UnreadableSecret | SqlError>;
		/** For /admin. Never the key itself. */
		readonly status: Effect.Effect<KeyStatus, SqlError>;
		/** Asks OpenRouter whether the key works, before it is saved. Why not, or none. */
		readonly check: (key: string) => Effect.Effect<Option.Option<string>>;
		/** Saves the key for every call, as set by the admin `by`. */
		readonly save: (key: string, by: string) => Effect.Effect<void, SqlError>;
	}
>()("ponder/openrouter/OpenRouterKey") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const secrets = yield* Secrets.Secrets;
	const api = yield* OpenRouter.OpenRouter;
	const client = yield* HttpClient.HttpClient;
	const cached = yield* Ref.make(Option.none<{ key: string; at: number }>());
	const envKey = Option.map(config.openRouterApiKey, Redacted.value);
	const checkUrl = api.url("v1/key");

	/** The saved key, or none. An unreadable one is logged, and the environment's key is used instead. */
	const savedKey = secrets.read(NAME).pipe(
		Effect.catchTags({
			UnreadableSecret: (error) =>
				Option.isNone(envKey) ? Effect.fail(error) : Effect.as(Effect.logError(`${error.message} Using OPENROUTER_API_KEY meanwhile.`), Option.none<string>()),
		}),
	);

	// No span of its own: every model call reads the key, nearly always from the cache.
	const key = Effect.gen(function* () {
		const known = yield* Ref.get(cached);
		if (Option.isSome(known) && (yield* Clock.currentTimeMillis) - known.value.at < CACHE_MS) return known.value.key;
		const found = Option.orElse(yield* savedKey, () => envKey);
		if (Option.isNone(found)) return yield* new NoOpenRouterKey();
		yield* Ref.set(cached, Option.some({ key: found.value, at: yield* Clock.currentTimeMillis }));
		return found.value;
	});

	const provider = Effect.map(key, (apiKey) => createOpenRouter({ apiKey, baseURL: api.url("v1") }));

	const status = Effect.gen(function* () {
		const info = yield* secrets.info(NAME);
		if (Option.isSome(info)) {
			const saved = yield* secrets.read(NAME).pipe(Effect.catchTags({ UnreadableSecret: () => Effect.succeedNone }));
			const fromSettings: KeyStatus = {
				source: "settings",
				hint: Option.match(saved, { onNone: () => null, onSome: hint }),
				unreadable: Option.isNone(saved),
				...info.value,
			};
			return fromSettings;
		}
		return Option.match(envKey, {
			onNone: (): KeyStatus => ({ source: "none", hint: null, unreadable: false, updatedAt: null, updatedBy: null }),
			onSome: (env): KeyStatus => ({ source: "environment", hint: hint(env), unreadable: false, updatedAt: null, updatedBy: null }),
		});
	}).pipe(Effect.withSpan("OpenRouterKey.status"));

	const check = Effect.fn("OpenRouterKey.check")(function* (candidate: string) {
		const response = yield* client.get(checkUrl, { headers: { Authorization: `Bearer ${candidate}` } }).pipe(Effect.timeout("10 seconds"), Effect.option);
		if (Option.isNone(response)) return Option.some("Could not reach OpenRouter to check the key. Try again.");
		const { status } = response.value;
		if (status >= 200 && status < 300) return Option.none<string>();
		if (status === 401 || status === 403) return Option.some("OpenRouter did not accept this key.");
		return Option.some(`OpenRouter could not check the key (HTTP ${status}). Try again.`);
	});

	const save = Effect.fn("OpenRouterKey.save")(function* (newKey: string, by: string) {
		yield* secrets.save(NAME, newKey, by);
		yield* Ref.set(cached, Option.some({ key: newKey, at: yield* Clock.currentTimeMillis }));
	});

	return OpenRouterKey.of({ key, provider, status, check, save });
});

export const layer = Layer.effect(OpenRouterKey, make);

function hint(key: string) {
	return key.length > 12 ? `…${key.slice(-4)}` : "…";
}
