/** PonderConfig: the defaults and the parsing that each module had, without a database. */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PonderConfig from "./config.ts";

const read = (env: Record<string, string>) =>
	Effect.gen(function* () {
		return yield* PonderConfig.PonderConfig;
	}).pipe(Effect.provide(PonderConfig.layerFromEnv(env)));

describe("PonderConfig", () => {
	it.effect("has the old defaults when nothing is set", () =>
		Effect.gen(function* () {
			const config = yield* read({});
			assert.isTrue(Option.isNone(config.databaseUrl));
			assert.deepStrictEqual(config.hosts, ["localhost:3500", "127.0.0.1:3500"]);
			assert.strictEqual(config.openRouterBaseUrl, "https://openrouter.ai/api");
			assert.strictEqual(config.defaultModel, "openrouter/auto");
			assert.strictEqual(config.maxSteps, 10);
			assert.strictEqual(config.dailyCredits, 1000);
			assert.strictEqual(config.creditsPerUsd, 1000);
			assert.strictEqual(config.sweepSeconds, 60);
			assert.strictEqual(config.otelServiceName, "ponder-chat");
			assert.strictEqual(config.otelBatchDelayMs, 2000);
			assert.strictEqual(config.sandboxDir, "sandbox/pyodide");
			assert.strictEqual(config.pythonMaxRuns, 3);
			assert.strictEqual(config.pythonMemoryMb, 1536);
			assert.strictEqual(config.searchBackend, "openrouter");
			assert.strictEqual(config.cloudflareApiUrl, "https://api.cloudflare.com/client/v4");
			assert.isTrue(config.memoryEnabled && config.memoryIndexEnabled && config.pythonEnabled);
			assert.isFalse(config.openSignup || config.allowPrivateNetworks || config.development);
			assert.isTrue(Option.isNone(config.objectStore) && Option.isNone(config.email) && Option.isNone(config.notifyUrl));
			assert.isTrue(Option.isNone(config.microsoftAuthority));
		}),
	);

	it.effect("parses lists, flags and URLs as the modules did", () =>
		Effect.gen(function* () {
			const config = yield* read({
				PORT: "4000",
				CHAT_ALLOWED_EMAILS: " Ana@Example.org, ,bo@example.org ",
				CHAT_OPEN_SIGNUP: "1",
				MCP_ALLOW_PRIVATE_NETWORKS: "true",
				PONDER_MEMORY: "off",
				OPENROUTER_BASE_URL: "http://127.0.0.1:3598/api/",
				PONDER_S3_BUCKET: "files",
				PONDER_S3_ENDPOINT: "https://r2.example/",
				PONDER_MICROSOFT_AUTHORITY: "http://127.0.0.1:3598/microsoft/",
			});
			assert.deepStrictEqual(config.hosts, ["localhost:4000", "127.0.0.1:4000"]);
			assert.deepStrictEqual(config.allowedEmails, ["ana@example.org", "bo@example.org"]);
			assert.isTrue(config.openSignup);
			// Only "1" turned it on.
			assert.isFalse(config.allowPrivateNetworks);
			assert.isFalse(config.memoryEnabled);
			assert.strictEqual(config.openRouterBaseUrl, "http://127.0.0.1:3598/api");
			assert.strictEqual(Option.getOrThrow(config.microsoftAuthority), "http://127.0.0.1:3598/microsoft");
			const store = Option.getOrThrow(config.objectStore);
			assert.deepStrictEqual([store.endpoint, store.region, store.accessKeyId, Redacted.value(store.secretAccessKey)], ["https://r2.example", "auto", "", ""]);
		}),
	);

	it.effect("keeps the old rules for empty and bad values", () =>
		Effect.gen(function* () {
			const config = yield* read({
				// `if (!X)`: empty is missing.
				OPENROUTER_API_KEY: "",
				BETTER_AUTH_SECRET: "",
				OTEL_EXPORTER_OTLP_ENDPOINT: "",
				OTEL_SERVICE_NAME: "",
				// `X ?? default`: empty is kept.
				CHAT_DEFAULT_MODEL: "",
				PONDER_HOSTS: "",
				// Number(): a bad value is NaN, or the default where the module used `|| default`.
				CHAT_MAX_STEPS: "many",
				PONDER_SWEEP_SECONDS: "0",
				OTEL_BSP_SCHEDULE_DELAY: "soon",
				// A whole number ≥ 0, or the default.
				CHAT_DAILY_CREDITS: "-5",
				CHAT_CREDITS_PER_USD: "12.6",
			});
			assert.isTrue(Option.isNone(config.openRouterApiKey) && Option.isNone(config.betterAuthSecret) && Option.isNone(config.otlpEndpoint));
			assert.strictEqual(config.otelServiceName, "ponder-chat");
			assert.strictEqual(config.defaultModel, "");
			assert.deepStrictEqual(config.hosts, []);
			assert.isNaN(config.maxSteps);
			assert.strictEqual(config.sweepSeconds, 60);
			assert.strictEqual(config.otelBatchDelayMs, 2000);
			assert.strictEqual(config.dailyCredits, 1000);
			assert.strictEqual(config.creditsPerUsd, 13);
		}),
	);

	it.effect("keeps secrets out of what it prints", () =>
		Effect.gen(function* () {
			const config = yield* read({ DATABASE_URL: "postgres://ponder:hunter2@db/ponder", BETTER_AUTH_SECRET: "s3cret" });
			assert.notInclude(JSON.stringify(config), "hunter2");
			assert.notInclude(String(Option.getOrThrow(config.betterAuthSecret)), "s3cret");
			assert.strictEqual(Redacted.value(Option.getOrThrow(config.databaseUrl)), "postgres://ponder:hunter2@db/ponder");
		}),
	);
});
