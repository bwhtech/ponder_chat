import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AUTO_MODEL_ID } from "../shared/auto-model.ts";

/**
 * Every environment variable that the server reads, read once, when the app's runtime
 * starts (server/runtime/). Each value has the default and the parsing that the module
 * that used it had, so a missing or odd value behaves as it did. Secrets are Redacted, so
 * a log line or an error that prints the config shows "<redacted>".
 *
 * Empty values: `X ?? default` in the old code kept an empty string, and `X || default`
 * or `if (!X)` did not. Both are kept here: the provider keeps empty strings, and each
 * field below says which rule it follows ("empty = missing" for the second).
 *
 * Not here, because only libraries and start.sh read them: WORKFLOW_TARGET_WORLD,
 * WORKFLOW_POSTGRES_URL, WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN and HOST
 * (Workflow and Nitro), and NODE_OPTIONS.
 */
export class PonderConfig extends Context.Service<
	PonderConfig,
	{
		// --- Database and sign-in
		/** DATABASE_URL. Ponder's Postgres. Without it the clients try localhost, as postgres.js did. Empty = missing. */
		readonly databaseUrl: Option.Option<Redacted.Redacted>;
		/** BETTER_AUTH_SECRET. Signs sessions, and the keys of saved secrets come from it (secrets/Secrets.ts). Empty = missing. */
		readonly betterAuthSecret: Option.Option<Redacted.Redacted>;
		/** PONDER_ENCRYPTION_KEY. When set, sealed values use a key from it instead (secrets/Secrets.ts). Empty = missing. */
		readonly encryptionKey: Option.Option<Redacted.Redacted>;
		/**
		 * PONDER_TOOL_APPROVAL_SECRET, as the operator set it. Empty = missing. When it is
		 * missing, startup.ts derives one from BETTER_AUTH_SECRET and puts it in the
		 * environment for workflow/approvals.ts, which reads it there.
		 */
		readonly toolApprovalSecret: Option.Option<Redacted.Redacted>;
		/** PONDER_HOSTS, split on commas; by default localhost and 127.0.0.1 on `port` (hosts.ts used it). */
		readonly hosts: ReadonlyArray<string>;
		/** PORT, default "3500". Nitro listens on it; hosts' default uses it. */
		readonly port: string;
		/** CHAT_OPEN_SIGNUP === "1": anyone may sign up (invites.ts). */
		readonly openSignup: boolean;
		/** CHAT_ALLOWED_EMAILS, split on commas, trimmed and lowercased (invites.ts). */
		readonly allowedEmails: ReadonlyArray<string>;
		/** NODE_ENV === "development" (web-build.ts). Nitro writes NODE_ENV into the build, so in production it is false. */
		readonly development: boolean;

		// --- OpenRouter and models
		/** OPENROUTER_API_KEY, used when no key is saved in /admin (openrouter/OpenRouterKey.ts). Empty = missing. */
		readonly openRouterApiKey: Option.Option<Redacted.Redacted>;
		/**
		 * OPENROUTER_BASE_URL, default https://openrouter.ai/api, without a trailing slash
		 * (openrouter/OpenRouter.ts). The e2e tests point it at the fake. tracing/http.ts treats an empty
		 * value as missing; OpenRouter.ts, which sends the requests, keeps it: this follows OpenRouter.ts.
		 */
		readonly openRouterBaseUrl: string;
		/** CHAT_DEFAULT_MODEL, default Auto (models/Models.ts). */
		readonly defaultModel: string;
		/** CHAT_MAX_STEPS, default 10: model calls in one reply (workflow/replies.ts). Number(), so a bad value is NaN, as before. */
		readonly maxSteps: number;
		/** PONDER_TITLE_MODEL, default z-ai/glm-5.3-flash (thread-title.ts). */
		readonly titleModel: string;
		/** PONDER_SEARCH_MODEL, default z-ai/glm-5.3-flash (search/openrouter-search.ts). */
		readonly searchModel: string;
		/** SEARCH_BACKEND, default "openrouter" (search/backend.ts refuses an unknown one when it is used). */
		readonly searchBackend: string;

		// --- Memory
		/** PONDER_MEMORY !== "off" (memory.ts). */
		readonly memoryEnabled: boolean;
		/** PONDER_MEMORY_INDEX !== "off": the pgvector index (memory.ts). */
		readonly memoryIndexEnabled: boolean;
		/** PONDER_MEMORY_MODEL, default z-ai/glm-5.3-flash (memory/extract.ts). */
		readonly memoryModel: string;
		/** PONDER_MEMORY_GATE_MODEL, default perplexity/pplx-decider-v1.2 (memory/decision-gate.ts). */
		readonly memoryGateModel: string;
		/** PONDER_EMBEDDING_MODEL, default google/gemini-embedding-2 (memory/pgvector-index.ts). */
		readonly embeddingModel: string;

		// --- Credits
		/** CHAT_DAILY_CREDITS, default 1000. A whole number ≥ 0, else the default. Only for the first start (settings/Settings.ts). */
		readonly dailyCredits: number;
		/** CHAT_CREDITS_PER_USD, default 1000. The same rules (settings/Settings.ts). */
		readonly creditsPerUsd: number;

		// --- Python sandbox (python/pyodide.ts)
		/** PONDER_PYTHON !== "off". */
		readonly pythonEnabled: boolean;
		/** PONDER_SANDBOX_DIR, default "sandbox/pyodide", relative to the folder the server starts in. pyodide.ts resolves it. */
		readonly sandboxDir: string;
		/** PONDER_DENO, default "deno". */
		readonly deno: string;
		/** PONDER_DENO_DIR. Without it, pyodide.ts uses `<sandbox dir>/.deno`. */
		readonly denoDir: Option.Option<string>;
		/** PYTHON_MAX_RUNS, default 3. Number(), as before. */
		readonly pythonMaxRuns: number;
		/** PYTHON_MEMORY_MB, default 1536. Number(), as before. */
		readonly pythonMemoryMb: number;
		/** PATH, default "": the only variable the sandbox's Deno gets from the server. */
		readonly path: string;

		// --- Files, email, alerts
		/** PONDER_S3_*: the bucket for attached files, when PONDER_S3_BUCKET and PONDER_S3_ENDPOINT are both set (files/ObjectStore.ts). */
		readonly objectStore: Option.Option<{
			readonly bucket: string;
			/** Without a trailing slash. */
			readonly endpoint: string;
			/** PONDER_S3_ACCESS_KEY_ID, default "". */
			readonly accessKeyId: string;
			/** PONDER_S3_SECRET_ACCESS_KEY, default "". */
			readonly secretAccessKey: Redacted.Redacted;
			/** PONDER_S3_REGION, default "auto" (R2). */
			readonly region: string;
		}>;
		/** PONDER_EMAIL_FROM, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_TOKEN, when all three are set (email/Mailer.ts). Empty = missing. */
		readonly email: Option.Option<{ readonly from: string; readonly accountId: string; readonly token: Redacted.Redacted }>;
		/** CLOUDFLARE_API_URL, default https://api.cloudflare.com/client/v4, without a trailing slash (email/Mailer.ts). */
		readonly cloudflareApiUrl: string;
		/** NOTIFY_URL: the ntfy topic for admin alerts (notify/Notify.ts). Anyone with it can read the alerts. Empty = missing. */
		readonly notifyUrl: Option.Option<Redacted.Redacted>;
		/** MCP_ALLOW_PRIVATE_NETWORKS === "1": connectors may reach private addresses, for the e2e tests (net/NetGuard.ts). */
		readonly allowPrivateNetworks: boolean;

		// --- Background work and tracing
		/** PONDER_SWEEP_SECONDS, default 60, at least 1 (workflow/sweep.ts). A bad value or 0 is the default. */
		readonly sweepSeconds: number;
		/** OTEL_EXPORTER_OTLP_ENDPOINT. Tracing is off without it (tracing/setup.ts). Empty = missing. */
		readonly otlpEndpoint: Option.Option<string>;
		/** OTEL_SERVICE_NAME, default "ponder-chat". Empty = missing. */
		readonly otelServiceName: string;
		/** OTEL_BSP_SCHEDULE_DELAY in milliseconds, default 2000. A bad value or 0 is the default. */
		readonly otelBatchDelayMs: number;
	}
>()("ponder/config/PonderConfig") {}

/** The raw value, with an empty string kept: the old code's `process.env.X`. */
const raw = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

/** `if (!X)`: an empty value counts as missing. */
const nonEmpty = (value: string | undefined) => (value ? Option.some(value) : Option.none());
const secret = (value: string | undefined) => Option.map(nonEmpty(value), Redacted.make);
const list = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
const withoutTrailingSlash = (url: string) => url.replace(/\/$/, "");

/** The old settings.ts's fromEnv: a whole number from the environment, ≥ 0, or the fallback. */
const wholeNumber = (value: string | undefined, fallback: number) => {
	const number = Math.round(Number(value ?? fallback));
	return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const make = Effect.gen(function* () {
	const env = yield* Config.all({
		DATABASE_URL: raw("DATABASE_URL"),
		BETTER_AUTH_SECRET: raw("BETTER_AUTH_SECRET"),
		PONDER_ENCRYPTION_KEY: raw("PONDER_ENCRYPTION_KEY"),
		PONDER_TOOL_APPROVAL_SECRET: raw("PONDER_TOOL_APPROVAL_SECRET"),
		PONDER_HOSTS: raw("PONDER_HOSTS"),
		PORT: raw("PORT"),
		CHAT_OPEN_SIGNUP: raw("CHAT_OPEN_SIGNUP"),
		CHAT_ALLOWED_EMAILS: raw("CHAT_ALLOWED_EMAILS"),
		NODE_ENV: raw("NODE_ENV"),
		OPENROUTER_API_KEY: raw("OPENROUTER_API_KEY"),
		OPENROUTER_BASE_URL: raw("OPENROUTER_BASE_URL"),
		CHAT_DEFAULT_MODEL: raw("CHAT_DEFAULT_MODEL"),
		CHAT_MAX_STEPS: raw("CHAT_MAX_STEPS"),
		PONDER_TITLE_MODEL: raw("PONDER_TITLE_MODEL"),
		PONDER_SEARCH_MODEL: raw("PONDER_SEARCH_MODEL"),
		SEARCH_BACKEND: raw("SEARCH_BACKEND"),
		PONDER_MEMORY: raw("PONDER_MEMORY"),
		PONDER_MEMORY_INDEX: raw("PONDER_MEMORY_INDEX"),
		PONDER_MEMORY_MODEL: raw("PONDER_MEMORY_MODEL"),
		PONDER_MEMORY_GATE_MODEL: raw("PONDER_MEMORY_GATE_MODEL"),
		PONDER_EMBEDDING_MODEL: raw("PONDER_EMBEDDING_MODEL"),
		CHAT_DAILY_CREDITS: raw("CHAT_DAILY_CREDITS"),
		CHAT_CREDITS_PER_USD: raw("CHAT_CREDITS_PER_USD"),
		PONDER_PYTHON: raw("PONDER_PYTHON"),
		PONDER_SANDBOX_DIR: raw("PONDER_SANDBOX_DIR"),
		PONDER_DENO: raw("PONDER_DENO"),
		PONDER_DENO_DIR: raw("PONDER_DENO_DIR"),
		PYTHON_MAX_RUNS: raw("PYTHON_MAX_RUNS"),
		PYTHON_MEMORY_MB: raw("PYTHON_MEMORY_MB"),
		PATH: raw("PATH"),
		PONDER_S3_BUCKET: raw("PONDER_S3_BUCKET"),
		PONDER_S3_ENDPOINT: raw("PONDER_S3_ENDPOINT"),
		PONDER_S3_ACCESS_KEY_ID: raw("PONDER_S3_ACCESS_KEY_ID"),
		PONDER_S3_SECRET_ACCESS_KEY: raw("PONDER_S3_SECRET_ACCESS_KEY"),
		PONDER_S3_REGION: raw("PONDER_S3_REGION"),
		PONDER_EMAIL_FROM: raw("PONDER_EMAIL_FROM"),
		CLOUDFLARE_ACCOUNT_ID: raw("CLOUDFLARE_ACCOUNT_ID"),
		CLOUDFLARE_EMAIL_TOKEN: raw("CLOUDFLARE_EMAIL_TOKEN"),
		CLOUDFLARE_API_URL: raw("CLOUDFLARE_API_URL"),
		NOTIFY_URL: raw("NOTIFY_URL"),
		MCP_ALLOW_PRIVATE_NETWORKS: raw("MCP_ALLOW_PRIVATE_NETWORKS"),
		PONDER_SWEEP_SECONDS: raw("PONDER_SWEEP_SECONDS"),
		OTEL_EXPORTER_OTLP_ENDPOINT: raw("OTEL_EXPORTER_OTLP_ENDPOINT"),
		OTEL_SERVICE_NAME: raw("OTEL_SERVICE_NAME"),
		OTEL_BSP_SCHEDULE_DELAY: raw("OTEL_BSP_SCHEDULE_DELAY"),
	});

	const port = env.PORT ?? "3500";
	const bucket = env.PONDER_S3_BUCKET;
	const endpoint = env.PONDER_S3_ENDPOINT === undefined ? undefined : withoutTrailingSlash(env.PONDER_S3_ENDPOINT);
	const [from, accountId, token] = [env.PONDER_EMAIL_FROM, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_EMAIL_TOKEN];

	return PonderConfig.of({
		databaseUrl: secret(env.DATABASE_URL),
		betterAuthSecret: secret(env.BETTER_AUTH_SECRET),
		encryptionKey: secret(env.PONDER_ENCRYPTION_KEY),
		toolApprovalSecret: secret(env.PONDER_TOOL_APPROVAL_SECRET),
		hosts: list(env.PONDER_HOSTS ?? `localhost:${port},127.0.0.1:${port}`),
		port,
		openSignup: env.CHAT_OPEN_SIGNUP === "1",
		allowedEmails: list(env.CHAT_ALLOWED_EMAILS ?? "").map((email) => email.toLowerCase()),
		development: env.NODE_ENV === "development",

		openRouterApiKey: secret(env.OPENROUTER_API_KEY),
		openRouterBaseUrl: withoutTrailingSlash(env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api"),
		defaultModel: env.CHAT_DEFAULT_MODEL ?? AUTO_MODEL_ID,
		maxSteps: Number(env.CHAT_MAX_STEPS ?? 10),
		titleModel: env.PONDER_TITLE_MODEL ?? "z-ai/glm-5.3-flash",
		searchModel: env.PONDER_SEARCH_MODEL ?? "z-ai/glm-5.3-flash",
		searchBackend: env.SEARCH_BACKEND ?? "openrouter",

		memoryEnabled: env.PONDER_MEMORY !== "off",
		memoryIndexEnabled: env.PONDER_MEMORY_INDEX !== "off",
		memoryModel: env.PONDER_MEMORY_MODEL ?? "z-ai/glm-5.3-flash",
		memoryGateModel: env.PONDER_MEMORY_GATE_MODEL ?? "perplexity/pplx-decider-v1.2",
		embeddingModel: env.PONDER_EMBEDDING_MODEL ?? "google/gemini-embedding-2",

		dailyCredits: wholeNumber(env.CHAT_DAILY_CREDITS, 1000),
		creditsPerUsd: wholeNumber(env.CHAT_CREDITS_PER_USD, 1000),

		pythonEnabled: env.PONDER_PYTHON !== "off",
		sandboxDir: env.PONDER_SANDBOX_DIR ?? "sandbox/pyodide",
		deno: env.PONDER_DENO ?? "deno",
		denoDir: Option.fromUndefinedOr(env.PONDER_DENO_DIR),
		pythonMaxRuns: Number(env.PYTHON_MAX_RUNS ?? 3),
		pythonMemoryMb: Number(env.PYTHON_MEMORY_MB ?? 1536),
		path: env.PATH ?? "",

		// The old object-store.ts checked `bucket && endpoint`: both set and not empty.
		objectStore:
			bucket && endpoint
				? Option.some({
						bucket,
						endpoint,
						accessKeyId: env.PONDER_S3_ACCESS_KEY_ID ?? "",
						secretAccessKey: Redacted.make(env.PONDER_S3_SECRET_ACCESS_KEY ?? ""),
						region: env.PONDER_S3_REGION ?? "auto",
					})
				: Option.none(),
		email: from && accountId && token ? Option.some({ from, accountId, token: Redacted.make(token) }) : Option.none(),
		cloudflareApiUrl: withoutTrailingSlash(env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com/client/v4"),
		notifyUrl: secret(env.NOTIFY_URL),
		allowPrivateNetworks: env.MCP_ALLOW_PRIVATE_NETWORKS === "1",

		sweepSeconds: Math.max(1, Number(env.PONDER_SWEEP_SECONDS) || 60),
		otlpEndpoint: nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT),
		otelServiceName: env.OTEL_SERVICE_NAME || "ponder-chat",
		otelBatchDelayMs: Number(env.OTEL_BSP_SCHEDULE_DELAY) || 2_000,
	});
});

const fromProcessEnv = ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv({ preserveEmptyStrings: true })));

/**
 * The config from the process's environment, as it is when the layer is built. Empty
 * strings are kept, so `?? default` fields keep them as the old code did.
 */
export const layer = Layer.effect(PonderConfig, make).pipe(Layer.provide(fromProcessEnv));

/** The config from a given environment, for tests. */
export const layerFromEnv = (env: Record<string, string>) =>
	Layer.effect(PonderConfig, make).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }))));
