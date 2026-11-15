# Effect in Ponder's server

Read this before you write or change Effect code in `server/`. The plan and its phases are in [effect-migration.md](effect-migration.md). The threads repository (`server/threads/Threads.ts`) is the reference module: copy its shape.

Effect is `effect` 4.1.1. The agent docs in `~/src/t3code/.repos/effect-smol/` are for 4.0.1, so check each name in `node_modules/effect/src/` and `node_modules/@effect/*/src/`. Some names that differ from older docs: `Config.String` (not `Config.string`), `Option.fromUndefinedOr`, `Effect.catchTags`, `Context.Service`, and `Threads.Threads.use((threads) => ...)`.

## Where things are

| File | What it holds |
| --- | --- |
| `server/runtime/layer.ts` | The app's layer: every service. Add a new service here. |
| `server/runtime/runtime.ts` | The one `ManagedRuntime`, on `globalThis`. `runPromise` for code that is not on Effect yet. `dispose` for SIGTERM. |
| `server/runtime/route.ts` | `route(c, effect, errors?)`: the boundary for Hono routes. |
| `server/runtime/step.ts` | `runStep(effect, rules?)`: the boundary for workflow steps. |
| `server/runtime/main.ts` | `runMain(effect)`: the boundary for scripts. |
| `server/runtime/Database.ts` | The `PgClient` layer (one pool), `ping`, and `pgCode` and `sqlMessage` for a `SqlError`. |
| `server/runtime/Http.ts` | Effect's `HttpClient` on fetch, with its own spans off, and `requestProblem` for log lines. |
| `server/config.ts` | `PonderConfig`: every environment variable. |
| `server/tracing/Tracing.ts` | Effect's tracer on Ponder's OpenTelemetry provider, and `annotate`. |
| `server/tracing/Logger.ts` | Effect's logger, in Ponder's console format. |
| `server/db.ts` | **Temporary.** The postgres.js `sql` for modules not on Effect yet. Phase 3 removes it. |

The platform services (Phase 1). Each module has its service, its errors, and the pure helpers that go with it:

| Service | Module | What it does | Fails with |
| --- | --- | --- | --- |
| `Secrets` | `server/secrets/Secrets.ts` | `migrate`, `read(name)`, `info(name)`, `save(name, value, by)`, `seal(context, value)`, `unseal(context, stored)` | `UnreadableSecret`, `SqlError` |
| `Settings` | `server/settings/Settings.ts` | `migrate`, `get` (kept 5 s), `update`, `setPdfTextOnServer`, `setCompactionModel`, `setAutoCostTier`. Types `AppSettings`, `AutoCostTier`. | `SqlError` |
| `OpenRouter` | `server/openrouter/OpenRouter.ts` | `url(path)`, `modelsWithZdr`, `modelsWithZdrNow`, `contextWindow(id)`. Pure: `privateRouting`, `privateRoutingBody`, `HELD_BACK_TOOL_CALLS`. | nothing: a list that can't be read is none, and logged |
| `OpenRouterKey` | `server/openrouter/OpenRouterKey.ts` | `key` (kept 1 min), `provider`, `status`, `check(key)`, `save(key, by)` | `NoOpenRouterKey`, `UnreadableSecret`, `SqlError` |
| `Models` | `server/models/Models.ts` | `available`, `cached`, `pick(id)`, `privateModels`. Pure: `MODELS`, `AUTO_MODEL`. | nothing |
| `AutoRouter` | `server/models/AutoRouter.ts` | `plugin`, `answeringModel(reported)`, `lastAnsweringModel(threadId)`, `modelWindow(id)` | `NoPrivateModel`, `SqlError` |
| `NetGuard` | `server/net/NetGuard.ts` | `fetch` (the guarded fetch), `publicAgent`, `privateNetworksAllowed`, `mcpUrlProblem(address)`. Pure: `isPrivate`, `assertPublicHost`. | the fetch rejects as before |
| `ObjectStore` | `server/files/ObjectStore.ts` | `enabled`, `put(key, data, type)`, `get(key)` | `ObjectStoreError` |
| `Mailer` | `server/email/Mailer.ts` | `send(email)`. Pure: the emails (`signInEmail`, `inviteEmail`, ...). | `EmailNotSent` |
| `Notify` | `server/notify/Notify.ts` | `admins(title, message, click?)` | nothing: a failure is logged |
| `Runs` | `server/telemetry/Runs.ts` | `migrate` (with `charged_runs`), `insert(row)`, `usageReport(query)`. Constants `UNCHARGED_CALLS`, `TITLE_FUNCTION_ID`, `COMPACTION_FUNCTION_ID`. | `SqlError` |
| `ModelCalls` | `server/telemetry/ModelCalls.ts` | `record(id, context)` gives an attempt's `start`, `finish`, `fail`; `settleEarlierAttempts`, `settle`, `stop`, `fillCosts`. Pure: `recordId`. | `SqlError` |
| `Telemetry` | `server/telemetry/Telemetry.ts` | `setup`: registers the AI SDK's telemetry and migrates `runs`. Pure: `runTelemetry`. | `SqlError` |

Plain modules, with no I/O and no environment: `server/hosts.ts` (`isLocalHost`, `originOf`; the hosts are `PonderConfig.hosts`), `server/validate.ts` (Hono's zod middleware: its schemas are the typed client's input types), `server/telemetry/cost.ts` (the workflow uses it) and `server/telemetry/run-recorder.ts` (the AI SDK's integration, a class that the SDK calls).

## House rules

1. **Imports.** Effect modules as namespaces from subpaths: `import * as Effect from "effect/Effect"`. A Ponder service module too: `import * as Threads from "../threads/Threads.ts"`, then `yield* Threads.Threads` and `Threads.layer`. Pure helpers, types and errors can be named imports.
2. **Services.** One module per service, in this order: imports, errors and schemas, the `Context.Service` class with its interface inline, `make`, `export const layer`. The tag is `"ponder/<area>/<Name>"`. The service type is `Threads["Service"]`; no `ThreadsShape`.
3. **Dependencies come from the environment** (`yield* PgClient.PgClient`). No module-level clients, pools or singletons. Config values and pure helpers can be parameters.
4. **Functions.** A reusable function that returns an Effect is `Effect.fn("Service.operation")(function* (...) {...})`. Keep a span name that exists now: `span("thread.load", ...)` became `Effect.fn("thread.load")`. Use `Effect.fnUntraced` for per-chunk or per-part work, with a comment that says why. Inline programs use `Effect.gen`. Do not write a function that only returns `Effect.gen`.
5. **Errors.** `Schema.TaggedError` classes with bounded fields: an operation, an id, a status. The message is fixed or built from those fields. The original error goes in `cause: Schema.Defect()`. No message text, file names, tool input or output, URLs with queries, or keys in fields or span attributes (`server/tracing/privacy.ts`). Catch with `Effect.catchTags({...})`, even for one tag. A failure that no caller can act on is a defect (`Effect.orDie`, or `catchTags({ SchemaError: Effect.die })`).
6. **Validation.** Decode untrusted data with `Schema`. Use `Predicate` (`Predicate.isObject`, `Predicate.hasProperty`), not your own `isRecord`.
7. **Time and waits.** `Clock`, `DateTime`, `Duration`, `Effect.sleep`, `Effect.timeout`, `Schedule`. No `setTimeout`, `Date.now()` or `new AbortController()` in services. For `fetch` or the AI SDK, use the signal of `Effect.tryPromise((signal) => ...)`.
8. **Resources.** Close what must be closed with `Effect.acquireRelease` or `Effect.ensuring`, in a `Scope`.
9. **Logs.** `Effect.logWarning`, `Effect.logError`, `Effect.log`: not `console.*`. Keep the text of the line as it was. See "Logging".
10. **Configuration.** Read environment variables only through `PonderConfig`. No `process.env` in other modules (the old modules still have theirs until their phase).
11. **Database.** `PgClient` from `@effect/sql-pg` (it is also `SqlClient`). Decode rows with `SqlSchema` and `Schema`. Work that must happen together goes in `sql.withTransaction`. Keep the SQL text.
12. **Boundaries.** Run effects only through `server/runtime/`: `route`, `runStep`, `runMain`, and `runPromise` for unconverted callers. No `runPromise` in a service, a repository or a layer.
13. **One runtime**, on `globalThis` (see "Runtime").
14. **Tracing** goes to the provider of `server/tracing/setup.ts` (see "Tracing").
15. **Tests.** `*.test.ts` with `@effect/vitest`. Test layers only for outside systems. No mocks of the logic under test, no sleeps or polling. The `*.check.ts` scripts stay and must pass.
16. **Comments** say why, in short plain sentences. Move them with the code.
17. **No shims.** Update every caller of a moved function. The only deliberate exceptions: `server/db.ts`'s `sql` (until Phase 3), `runPromise` in `runtime.ts` (until the last caller is on Effect), and `Telemetry`'s `Effect.runPromiseWith` for the AI SDK's callbacks into `RunRecorder`, on the services of its layer.

## A service module

`server/threads/Threads.ts`, shortened:

```ts
export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

const OwnerRow = Schema.Struct({ owner: Schema.String });

export class Threads extends Context.Service<
	Threads,
	{
		readonly migrate: Effect.Effect<void, SqlError>;
		readonly load: (id: string) => Effect.Effect<UIMessage[], SqlError>;
		readonly owner: (id: string) => Effect.Effect<Option.Option<string>, SqlError>;
		// ...
	}
>()("ponder/threads/Threads") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	const findOwner = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: OwnerRow,
		execute: (id) => sql`select owner from threads where id = ${id}`,
	});

	// The span's name and attribute are the ones span.ts gave it: tracing.spec.ts looks for them.
	const load = Effect.fn("thread.load")(function* (id: string) {
		const row = yield* findMessages(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		const messages = Option.match(row, { onNone: (): UIMessage[] => [], onSome: (found) => found.messages });
		yield* Tracing.annotate({ "ponder.messages": messages.length });
		return messages;
	});

	const owner = Effect.fn("Threads.owner")(function* (id: string) {
		const row = yield* findOwner(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.owner);
	});

	return Threads.of({ migrate, load, owner /* ... */ });
});

export const layer = Layer.effect(Threads, make);
```

- A repository keeps the driver's `SqlError` in its signature, so callers see that the database can fail. A caller that can't act on it lets it reach its boundary, which answers 500 or lets Workflow retry, as before.
- "Not found" is `Option`, not `null` or `undefined`. A Promise caller converts at its call: `Option.getOrNull(...)`.
- A row that does not decode is a bug: `SchemaError` becomes a defect.
- Add the layer to `server/runtime/layer.ts`, with what it needs below it.

## Errors

```ts
export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
	threadId: Schema.String,
}) {
	override get message() {
		return `Thread ${this.threadId} was not found.`;
	}
}
```

The tag is what `route`, `runStep` and `Effect.catchTags` use, and it becomes the span's `error.type`. Never build the message from the cause or from content.

## Config

`PonderConfig` (`server/config.ts`) has every variable that the server read with `process.env`, with the same default and parsing. Each field's comment names the variable, its default and the module that used it. Secrets are `Redacted`; read one with `Redacted.value(...)` only where it is used.

```ts
const config = yield* PonderConfig.PonderConfig;
const steps = config.maxSteps; // CHAT_MAX_STEPS, default 10
```

- The layer reads the environment once, when the runtime is built. Some modules read `process.env` at each call before (notify.ts, secrets.ts, net-guard.ts, tracing/http.ts). On `PonderConfig`, they see the value at start: `NOTIFY_URL`, the keys of `Secrets` and `MCP_ALLOW_PRIVATE_NETWORKS` (`NetGuard`) are read once. Nothing changes the environment in production, and the e2e server gets its environment before it starts. A check script that sets `process.env` must do it before the runtime is built: `server/mcp.check.ts` sets `MCP_ALLOW_PRIVATE_NETWORKS=1` at its top, and checks the strict guard on a `NetGuard` layer of its own (`PonderConfig.layerFromEnv({})`).
- Empty values keep the old rule of each module: `X ?? default` kept `""`; `X || default` and `if (!X)` did not. The field's comment says "Empty = missing" for the second kind.
- `PONDER_TOOL_APPROVAL_SECRET`: the field is what the operator set. startup.ts still derives it from `BETTER_AUTH_SECRET` and writes it to `process.env` for workflow/approvals.ts. Phase 3 moves this to a value in the runtime.
- Tests: `PonderConfig.layerFromEnv({ DATABASE_URL: url })`.
- To add a variable: add the field with its comment, read it with `raw("NAME")` in `make`, and add a case to `server/config.test.ts`.

## Database

**Decision: `@effect/sql-pg` (`PgClient`).** It speaks Postgres's protocol itself, with no driver package. The evidence is `server/runtime/Database.test.ts`, run on `pgvector/pgvector:pg18`:

| What Ponder needs | Result |
| --- | --- |
| jsonb in and out (`sql.json(messages)`) | Works. Read back deep-equal, with Unicode, escapes and big numbers. jsonb orders object keys, as with postgres.js. |
| The generated `tsvector` column and GIN search (`sql.unsafe` migration) | Works. `search @@ to_tsquery(...)` and `ts_rank(search, q)` work. |
| pgvector `vector` columns | Writes (`'[1,2]'::vector`, or a string into a vector column) and `<=>` work. |
| Arrays | `= any(${ids})` (also empty), `in ${sql.in(ids)}`, `array_agg` back as a JS array. |
| `timestamptz` | Comes back as a `Date`, as with postgres.js. `Date` parameters bind as timestamptz. |
| Transactions | `sql.withTransaction(effect)`; a failure rolls back. |
| `sql.unsafe` | Works for one statement, with or without parameters. |
| Notices | Dropped by the client (`onnotice: () => {}` before). |
| Pool | 10 connections at most, as postgres.js. Opens connections when a query needs one. |
| Errors | `SqlError` with a `reason` (`SqlSyntaxError`, `UniqueViolation`, `ConnectionError`...). The Postgres code is on `error.reason.cause.code`. |

Differences from postgres.js that later phases must handle:

- **`bigint` (int8) comes back as a JS `bigint`**, not a string. `count(*)`, `sum()` of integers and `bigserial` ids (`skills.id`) are int8. `JSON.stringify` throws on a bigint. Cast in SQL (`count(*)::int`, as Ponder mostly does) or decode with `Schema`.
- **A raw `vector` or `tsvector` column can't be read.** The client reads every column in binary and has no codec for them: it fails, or gives bytes. Select `embedding::text`, or compute in SQL (`<=>`, `ts_rank`). Ponder reads neither today.
- **One statement per `sql.unsafe`.** postgres.js allowed `"select 1; select 2"`. Split them.
- **`sql(rows)` becomes `sql.insert(rows)`, `sql(ids)` in `in (...)` becomes `sql.in(ids)`, `sql.begin` becomes `sql.withTransaction`, `sql.reserve` is `sql.reserve` (scoped).** `sql.json` is on `PgClient`, not on `SqlClient`: depend on `PgClient.PgClient`.
- **`numeric` comes back as a string**, as before. `runs.cost_usd` is `numeric(12, 6)`: `"0.000123"`. Cast to `float8` in SQL where a number is wanted (`usageReport`, credits.ts).
- **Parameters have a type.** A JS integer binds as `int4` (or `int8` past 2³¹), another number as `float8`, a boolean as `bool`, a `Date` as `timestamptz`; a string has no type, so Postgres takes the column's. A `float8` parameter goes into a `numeric` column by Postgres's assignment cast, and is rounded to the column's places, as postgres.js's text was. An `int4` works in `make_interval(days => ...)` and `limit`. A function that takes no `float8` gets an error for a non-integer number: cast the parameter in SQL.
- **A `SqlError`'s `message` is the client's** ("PgConnection: Query failed"), not Postgres's. Postgres's message and code are on `error.reason.cause`. A log line that printed `error.message` of a postgres.js error printed Postgres's text: keep that by printing the cause's message.
- Idle connections close after 60 seconds (postgres.js kept them).
- **A row can be up to 1 GiB** (`maxMessageSize` in `server/runtime/Database.ts`), as with postgres.js. The client's default is 16 MiB, less than a long thread's `messages`.
- **The client reads only `DATABASE_URL`.** postgres.js also read `PGUSER`, `PGPASSWORD`, `PGHOST` and the others, and treated `sslmode=require` as "encrypt, but don't verify the certificate". Here `sslmode=require` verifies it. Every Ponder deployment puts the user and password in `DATABASE_URL` and connects to 127.0.0.1 without TLS, so neither matters today. A deployment that needs them must say so in `DATABASE_URL`, or pass `ssl` options in the layer.
- **Interrupting a query waits for the client to cancel it** on the server: seconds, on a hung connection. A deadline that a person waits on runs the query in a fiber of its own, as `Database.pingWithin` does for /health.

Until Phase 3 two pools run: postgres.js (`server/db.ts`) and `PgClient`. Up to 20 connections, plus better-auth's 5 and Workflow's own.

## Outbound HTTP

**Decision: Effect's `HttpClient` (`server/runtime/Http.ts`) for the services Ponder itself calls** (OpenRouter's API, ntfy, Cloudflare's email API). It is `FetchHttpClient`, so the requests are Node's fetch as before. A test gives a fake `HttpClient` (`HttpClient.make(...)` in a `Layer.succeed`) instead of a server.

- The client's own spans are off (`HttpClient.TracerDisabledWhen`). `tracing/http.ts` already makes one span for each request, from undici's channels, with only what may leave Ponder. The client's span would be a second one, with the full address, and it would send a `traceparent` header, which `tracing/http.ts` says never goes out.
- Timeouts are `Effect.timeout` with the old values (`AbortSignal.timeout` before): interrupting the request aborts the fetch. A timeout covers the request and the reading of its body, as the signal did.
- A non-2xx answer is a value, not a failure, unless the code asks for `HttpClientResponse.filterStatusOk`. Bodies are decoded with `HttpClientResponse.schemaBodyJson` and a lenient `Schema` (optional and nullable fields), so a field OpenRouter adds or leaves out changes nothing.
- Never log an `HttpClientError`'s message: it holds the address, with its query. `requestProblem(error)` gives what the old log lines printed: `HTTP 503`, fetch's own message, or AbortSignal.timeout's.
- **Addresses that people or the model choose** go through `NetGuard` (`server/net/NetGuard.ts`): its `fetch` is the guarded fetch, unchanged (public addresses only, checked on each connection; a GET follows 3 checked redirects; other methods get the redirect as the answer). It stays a plain `typeof fetch`, because the libraries that use it (@ai-sdk/mcp) take one. Effect code that wants an `HttpClient` on it provides `FetchHttpClient.Fetch` with it. web_fetch uses `publicAgent` with undici directly. The agent closes with the runtime.
- `ObjectStore` keeps aws4fetch, which signs each request and retries an answer of 5xx or 429 itself; `Effect.tryPromise((signal) => client.fetch(url, { signal }))` gives it the signal.

## Connectors (MCP)

`server/mcp/layer.ts` holds the connector services: `ConnectorStore` (the SQL), `ConnectorOAuth` (sign-ins and refreshes), `McpTransport` (@ai-sdk/mcp's client on the guarded fetch), `McpClients` (clients as resources) and `Connectors` (what the routes and the steps call). The catalog, ranking, signatures and input checks stay plain functions: the workflow loads them.

- A client is opened with `Effect.acquireRelease` and closed with its scope. The pool is an `RcMap` with an idle time of 2 minutes, so a client is never closed while a call uses it, and the idle close runs on Effect's clock (a test moves it with `TestClock`). A client that failed, or that `forget` took out, keeps its old key, so a late error on it does not take out the newer one.
- The timeouts (15 s connect, 20 s list, 60 s call) are `Effect.timeout`. The SDK gets the signal of `Effect.tryPromise`, so a timeout aborts the request.
- The SDK calls the OAuth provider back with plain functions, some of them sync getters. `ConnectorOAuth` builds the provider with the hosts and the clock already read, and runs its effects (saving credentials, reading metadata) with `Effect.runPromiseWith` on its own context. A `ConnectorProblem` that the provider throws inside the SDK comes out as itself (`sdkFailure`).
- Errors: `ConnectorProblem` (a `reason`, and only the header name or the address problem that the person typed), `NeedsSignIn`, and `ConnectorFailed` (an `operation`, with what the server or the network said in `cause`). `describeError` reads the cause for the sentence the person sees.
- A test gives a fake `McpTransport` in place of an MCP server (`server/mcp/McpClients.test.ts`).

## Memory and compaction

- `Memory` (`server/memory.ts`) is what the steps and routes call: `forRun`, `rememberTurn`, `overview`, `update`, `forget`, `undo`, `threadSaves`, `setup`. Under it, `MemoryStore` (`server/memory/postgres.ts`) is the adapter. TanStack's memory contract (`memory/types.ts`) keeps its shapes, but each method returns an Effect. `MemoryStore.makeWith({ extract, index })` makes a store with other parts, as memory.check.ts does with a stand-in extractor.
- The gate, the writer and the pgvector index are made from the environment (`makeDecisionGate`, `makeLlmWriter`, `makePgvectorIndex`). The gate calls the Decisions API with `HttpClient`; the writer, the embeddings and the summarizer call the AI SDK in `Effect.tryPromise` with its signal.
- Background saves are fibers in the Memory layer's scope (`Effect.forkIn`). A fork keeps the caller's async context, so `memory.save` is in the reply's trace.
- Memory never stops a chat: recall and save recover from any failure or defect (`recoverAll` in `memory/errors.ts`), and log it. An interruption stays one.
- Errors name the model and the HTTP status, never the provider's answer: `MemoryGateFailed`, `MemoryWriterFailed`, `EmbeddingFailed`, `SummaryFailed`. The text in the save log and in the log lines is `problem(error)`: Postgres's own message for a `SqlError`, else the error's message.
- Compaction: `CompactionStore` (`compaction/store.ts`), `Summarizer` (`compaction/summarize.ts`), and `compact` (`compaction/compact.ts`), which `compactStep` runs with `runStep`. The engine (`runCompaction` in `compaction/compaction.ts`) takes its parts as Effects, so `compaction-flow.check.ts` runs it with fakes. On the step's last attempt, any failure of the summary (not an interruption) leaves the old messages out.

## Tools and files

- Services: `Files` (`server/files.ts`: `migrate`, `save`, `store`, `load`, `pdfText`), `PdfText` (`server/pdf-text.ts`: `extract`), `Sandbox` (`server/python/pyodide.ts`: `enabled`, `check`, `run`), `PythonState` (`server/python/state.ts`), `RunPython` (`server/python/tool.ts`: `execute`, one turn at a time per thread), `SearchBackend` (`server/search/backend.ts`, chosen by `SEARCH_BACKEND`), `Skills` (`server/skills.ts`) and `ThreadCache` (`server/thread-cache.ts`). Effect functions on the environment: `resolveFileParts`, `prepareImage`, `fetchPage`, `executeWebSearch`, `executeWebFetch`, `searchThreads`, `nameThread`, `seedStandardSkills`, `threadResponse`. `trusted-pages.ts`, the tool schemas (zod, for the AI SDK) and `artifacts/` stay plain: the workflow loads them.
- The PDF worker and the Deno process are resources: `Effect.acquireRelease` starts one and listens to it in the same step, and the release stops it (`worker.terminate()`; SIGKILL to the process group, then a wait for its pipes to close). A timeout (`Effect.timeoutOrElse`, 20 s and 60 s as before) or an interruption runs the release. Turns are `Semaphore`s, which serve waiters in order.
- `Sandbox.run` has no span of its own, so its `ponder.wait_ms` lands on the caller's `python.run`, as before. `fetchPage` has none either: `web_fetch.read` is its span, and `withPeer("web")` wraps each request.
- Answers for the person or the model are built at the edge from bounded errors: `refusalText(name, FileRefused)` for an upload, the tool's `error` text from `PageRefused` and `PageUnreachable` (the cause's message, as undici gave it) for web_fetch.
- `server/python/pyodide.test.ts` fakes Deno with a small Node program, and moves the run's 60 seconds with `TestClock`.

## People and admin

- `server/admin/layer.ts` holds them: `Auth` (`server/auth/Auth.ts`), `AdminAuthEvents`, `Accounts` and `Invites` (`server/people/`), `Credits` and `ExtraCredits` (`server/credits/`), `RateLimits` (`server/limits/`), `AdminEvents`, `AdminReports` (what /admin reads) and `AdminActions` (what /admin changes), and `WebBuild` (`server/web-build.ts`: the start-up check and the chat page's template). `server/admin/people.ts`, `usage.ts` and `activity.ts` are the plain parts of the reports.
- Better Auth keeps its own `pg` pool (5) and its options. `Auth` makes it on first use (`Effect.cached`), with the hosts and the secret of `PonderConfig`, so a script or a check that never signs anyone in opens no pool; the pool closes with the runtime. Better Auth's hooks and email callbacks run on the layer's services with `Effect.runPromiseWith`. Its endpoints are called through `auth.call((api) => ...)`: a refusal is `AuthRefused` (its status and Better Auth's own fixed text), anything else a defect. `auth.session(headers)` is the session cached for a minute (`auth/session-cache.ts`), `auth.getSession(headers)` reads it each time. `appOrigin(headers)` is an Effect on `PonderConfig`'s hosts.
- Hono middleware stays middleware and calls the services through `route` (the session check in app.ts, `requireAdmin`, `limitPerPerson` in `server/rate-limit.ts`).
- Credits read the day from `Clock`; the tests give a fixed wall clock (`server/credits/Credits.test.ts`). The rate-limit windows run on `Clock` too (`TestClock` in `server/limits/RateLimits.test.ts`).
- The tests that need `users` run in a schema of their own: `?options=-csearch_path=<schema>` on `TEST_DATABASE_URL`, dropped at the end. Other test files make and drop a `users` table of another shape at the same time.

## Errors of a service, and their messages

Each failure a person or a caller can act on is a tagged error with a fixed message. Where the old error had the other side's answer in its message (Cloudflare's or the bucket's body), the new one has the status only: an answer can name an address or a file. `UnreadableSecret` names the secret ("openrouter_api_key") and the variable of its key, never a value. Where a log line printed a postgres.js error's message, it now prints `sqlMessage(error)`, Postgres's own text.

## Boundaries

### Routes: `route(c, effect, errors?)`

The effect builds the answer with `c.json` or `c.text`, so Hono still infers the route's answers for `web/api.ts`. `errors` maps tags to answers. A failure with no answer, and any defect, is thrown as the error itself, so `app.onError` logs it and answers 500 as before. The request closing does not interrupt the effect.

The reference thin route, `/health` in `server/app.ts`:

```ts
const databaseUnavailable = (_: unknown, c: Context) => c.text("database unavailable", 503);
app.get("/health", (c) =>
	route(c, Database.ping.pipe(Effect.timeout("3 seconds"), Effect.map(() => c.text("ok"))), {
		SqlError: databaseUnavailable,
		TimeoutError: databaseUnavailable,
	}),
);
```

A route in the typed chain:

```ts
.patch("/api/threads/:id", validate("json", threadTitle), (c) =>
	route(
		c,
		Effect.map(
			Threads.Threads.use((threads) => threads.rename(c.req.param("id"), userOf(c), c.req.valid("json").title)),
			(renamed) => (renamed ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)),
		),
	),
)
```

A route decodes, calls one service method and maps its errors. Nothing else.

### Workflow steps: `runStep(effect, rules?)`

Load it inside the step, as steps load all their modules (the workflow imports `steps.ts`, and workflow code can't load Node modules):

```ts
export async function trustedPagesStep(threadId: string): Promise<string[]> {
	"use step";
	return contextStep("trusted pages", `thread ${threadId}`, async () => {
		const { runStep } = await import("../runtime/step.ts");
		const Threads = await import("../threads/Threads.ts");
		const { trustedPageKeys } = await import("../search/trusted-pages.ts");
		return trustedPageKeys(await runStep(Threads.Threads.use((threads) => threads.load(threadId))));
	});
}
```

- By default a failure is thrown as the error itself (the first failure, else the defect). Workflow then retries the step as it did: up to `maxRetries`, then it fails.
- `{ fatal: ["ThreadGone"] }`: these tags throw `FatalError` (no retry).
- `{ retryable: { RateLimited: (error) => ({ retryAfter: error.afterMs }) } }`: these tags throw `RetryableError`, which runs the step again after that time.
- Both carry the error's `message`. Effect retries inside one attempt (`Effect.retry`); these rules say what Workflow does after the attempt fails.
- `"use workflow"` bodies (`server/workflow/chat.ts`) stay plain async. No Effect there.

### Scripts: `runMain(effect)`

Runs the program on the app's runtime, prints a failure's Cause and sets exit code 1, then disposes the runtime so the pool closes. It does not exit the process.

### Callbacks from a library: `Effect.runPromiseWith(context)`

A library that calls Ponder back, such as the AI SDK's telemetry (`RunRecorder`), gets a plain function. The service that makes it takes its layer's context (`yield* Effect.context<never>()`) and runs the callback's effect on it, with the runtime's pool, logger and tracer (`server/telemetry/Telemetry.ts`). The effect handles its own failures: the callback never rejects.

### Code not on Effect yet: `runPromise(effect)`

From `server/runtime/runtime.ts`. A failure rejects with the error itself, not a wrapper:

```ts
const messages = await runPromise(Threads.Threads.use((threads) => threads.load(threadId)));
```

Use it only in a module that is not converted yet. When you convert a module, its calls become `yield*`.

## Runtime

`runtime()` builds one `ManagedRuntime` from `layer.ts` on first use, and keeps it at `globalThis[Symbol.for("ponder.runtime")]`. The Nitro build can hold more than one copy of a module (the routes, the plugins and the steps), and all copies must share one runtime and one pool. The first migration in `startup.ts` builds it. On SIGTERM, `startup.ts` stops in this order: the sweeps, the workflow worker, `dispose()` (the Effect pool), postgres.js's `sql.end`, then the last spans. A disposed runtime stays in place, so a late call fails instead of opening a new pool.

## Tracing

`Tracing.layer` puts Effect's spans on the OpenTelemetry provider that `server/tracing/setup.ts` registers. So the sampler (only inside a reply's trace), the durable ids and the allowlist (`privacy.ts`) apply to them. The provider holds the Resource (`service.name`, `service.instance.id`). `server/tracing.check.ts` checks all of this.

- An Effect span with no Effect parent takes the active OpenTelemetry span as its parent (a step inside a reply, an HTTP request). Code run inside an Effect span, such as `Effect.tryPromise(() => streamText(...))`, sees that span as active, so the AI SDK's spans nest under it.
- A span name must be on `KNOWN_NAMES` in `privacy.ts`, or it is sent as `"span"`. `Service.operation` names (`Threads.list`) and `sql.transaction` are on it. Ponder's older names (`thread.load`, `reply.save`) are listed one by one: keep them.
- A failed span gets `error.type` from the error's code, else its tag, else its class name (`span.ts`'s `errorType`). For a `SqlError` it is the Postgres or socket code, as with postgres.js. Never the message. An interrupted span is not failed.
- A failed Effect span also has an `exception` event; `privacy.ts` keeps only its type. A span that ends well has status OK (span.ts left it unset).
- Attributes: `yield* Tracing.annotate({ "ponder.messages": n })`. Undefined values are left out. Counts, sizes, ids and outcomes only.
- Effect's SQL client makes a span for each statement, named `"postgres"`. The sampler in `setup.ts` drops it: postgres.js made none, and Ponder's own spans say enough. `Database.test.ts` checks the name.
- Do not set `Statement.SpanPropagationEnabled`: it would hang driver spans under the dropped statement spans.

## Logging

`Logger.layer` writes Effect's logs as Ponder's console lines: `Effect.logWarning("replies: could not cancel run", id)` prints what `console.warn("replies: could not cancel run", id)` printed. Error and Fatal go to `console.error`, Warn to `console.warn`, Info to `console.log`. No date, level or fiber prefix: `deploy/sentinel.sh` reads the lines as they are. When tracing is on, `logs.ts` ends each error and warning inside a trace with ` trace_id=<id>`; inside an Effect span that is the span's trace. A `Cause` passed to a log is printed pretty after the message.

## Tests

- `npm run test` runs `server/**/*.test.ts` with vitest (`vitest.config.ts`).
- Tests that need Postgres run only when `TEST_DATABASE_URL` is set, and skip otherwise. It is not `DATABASE_URL`, so a shell with the real database in its environment never runs them there. They make their own rows or tables and delete them. CI runs them in the e2e job, on the service's `postgres` database.
- Locally: start a container (effect-migration.md, "Checks for each phase"), then `TEST_DATABASE_URL=postgres://ponder:ponder@127.0.0.1:<port>/postgres npm run test`.
- Add each new test file to `typecheck:server` in `package.json`; vitest does not check types.

The repository test, `server/threads/Threads.test.ts`:

```ts
const url = process.env.TEST_DATABASE_URL;
const layer = Threads.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

describe.skipIf(!url)("Threads", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("knows nothing of a thread not saved yet", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				assert.deepStrictEqual(yield* threads.owner(id("none")), Option.none());
			}),
		);
	});
});
```

`excludeTestServices: true` uses the real clock, for a real database. For logic with time, use `it.effect` without it and move time with `TestClock`.

## What stays as it is

| Part | Why |
| --- | --- |
| `"use workflow"` bodies (`server/workflow/chat.ts`) | Workflow replays them in a deterministic sandbox. Steps move, through `runStep`. |
| Durable retries between steps | Workflow owns them (`maxRetries`, `FatalError`, `RetryableError`). |
| The AI SDK (`streamText`, `UIMessage`, `@ai-sdk/mcp`, `@ai-sdk/workflow`) | Wrap its calls (`Effect.tryPromise`, `Stream.fromAsyncIterable`, `acquireRelease`). Do not port to `effect/ai`. |
| Hono and `hc<AppType>` (`web/api.ts`) | Routes become thin, through `route`. |
| better-auth | Its own pool. Wrap its calls. |
| The web app (`web/`) | Out of scope. |
| Pure functions | A slug or a prompt string stays a plain function. |
| `*-worker.ts` files | A worker is its own program; the parent calls it through Effect. |
| `server/tracing/setup.ts`, `privacy.ts`, `reply-trace.ts`, `http.ts` | Effect's spans go through them; Phase 3 decides what moves. |

## How to migrate a module

1. Read this file, and the module and all its callers (`grep` its exports).
2. Write the service module: errors, the `Context.Service` class, `make`, `layer`. Get clients from the environment. Read config from `PonderConfig` (add the fields you need, with a test).
3. Move each function into `make` as `Effect.fn("Service.operation")`. Keep span names that exist, and add a new name's pattern to `privacy.ts` if it does not match `Service.operation`. Keep SQL text, log text and comments.
4. Make failures `Schema.TaggedError`s with bounded fields, or keep `SqlError` for a repository. Make "can't happen" failures defects.
5. Replace postgres.js calls with `PgClient` (see "Database" for the differences). Decode rows with `SqlSchema`.
6. Replace `setTimeout`, `AbortController`, `Date.now()`, `console.*` and `.catch(() => undefined)` with Effect's own (rules 7 to 9).
7. Add the layer to `server/runtime/layer.ts`.
8. Update every caller. Effect callers `yield*` it. Routes use `route`, steps use `runStep` (loaded inside the step), scripts use `runMain`. Other unconverted callers use `runPromise`. Delete the old functions and the module's `sql` import from `db.ts`. No Promise copies.
9. Write a `*.test.ts` with `@effect/vitest`, with test layers only for outside systems. Add it to `typecheck:server`.
10. Run `npm run typecheck`, `npm run typecheck:server`, `npm run typecheck:e2e`, `npm run test` (with `TEST_DATABASE_URL`), and the `*.check.ts` scripts of the area.
