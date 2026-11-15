# Moving Ponder's server to Effect

This plan moves Ponder's server code to [Effect](https://effect.website) v4. Agents do the work in phases. Each phase ends with a review and a full check. The result is one pull request: `feat/effect-migration`.

## Why

When all of the server is in Effect, agents read and change the code more safely:

- Every failure has a type. A function's signature tells what can fail, and callers must handle it.
- Dependencies come from layers, not module globals. A test gives a fake layer for an outside system and does not need a real OpenRouter or MCP server.
- Timeouts, retries, interruption and cleanup are combinators: `Effect.timeout`, `Schedule`, `Effect.acquireRelease`, `Effect.ensuring`. They replace hand-written `AbortController`, `setTimeout`, `try/finally` and `.catch(() => undefined)`.
- `Effect.fn("Name")` makes a span, so tracing comes with each function.

## What moves, and what stays

**Moves to Effect:** all code in `server/` that does I/O or holds business rules: the database, OpenRouter, connectors (MCP), memory, compaction, search, files, Python, admin, auth glue, credits, telemetry, tracing helpers, startup and the reply engine's steps.

**Stays as it is, by design:**

| Part | Why it stays |
| --- | --- |
| `"use workflow"` function bodies (`server/workflow/chat.ts`) | Workflow DevKit replays them in a deterministic sandbox. Effect's fiber runtime, clock and random do not belong there. Steps (`"use step"`) do move: their bodies run Effect through `runStep`. |
| Durable retries between steps | Workflow DevKit owns them (`RetryableError`, `FatalError`, `maxRetries`). Effect retries only inside one step. |
| The AI SDK (`streamText`, `UIMessage`, `@ai-sdk/mcp`, `@ai-sdk/workflow`) | The web app and the workflow depend on its types. Effect wraps the calls: `Stream.fromAsyncIterable`, `Effect.tryPromise`, `acquireRelease`. Do not port to `effect/ai`. |
| Hono, and the typed client `hc<AppType>` in `web/api.ts` | The web app's types come from the route chain in `server/app.ts`. Routes become thin: decode, call one service method, map errors. |
| better-auth | A library with its own database pool. Wrap its calls; do not replace it. |
| The Vue web app (`web/`) | Out of scope. |
| Pure functions (a slug, a token estimate, a prompt string) | Plain functions are fine next to a service. Effect is for I/O and for rules that can fail. |
| Worker thread files (`*-worker.ts`) | A worker thread runs its own small program. The parent side calls it through Effect. |

## Versions and sources

- `effect` 4.1.1, `@effect/platform-node` 4.1.1, `@effect/sql-pg` 4.1.1, `@effect/opentelemetry` 4.1.1, `@effect/vitest` 4.1.1 and `vitest` 5.0.5, all pinned. They are installed in the worktree.
- Use the installed source for the exact API: `node_modules/effect/src/` and `node_modules/@effect/*/src/`. The docs for agents are in `~/src/t3code/.repos/effect-smol/` (version 4.0.1, so check names against the installed source):
  - `LLMS.md`: how to write Effect code. Read it first.
  - `ai-docs/src/`: examples for services, layers, errors, resources, streams, schedules, observability, testing, SQL, HTTP clients and integration with Hono (`04_integration/10_managed-runtime.ts`).
- A large real codebase in this style: T3 Code, `~/src/t3code/apps/server/src/`. Its rules are in `~/src/t3code/docs/internals/effect-services.md`. Read it. Ponder follows most of it (see the house rules below). Read only; never import from it.

## House rules

`docs/effect.md` holds these rules with Ponder examples. Phase 0 writes it. Every agent reads it before it writes code.

1. **Imports.** Import modules as namespaces from subpaths: `import * as Effect from "effect/Effect"`. Import a Ponder service module as a namespace too: `import * as Threads from "../threads/Threads.ts"`, then `yield* Threads.Threads` and `Threads.layer`.
2. **Services.** Each feature is a `Context.Service` class with its interface inline. The module order is: imports, errors and schemas, the service class, `make` (an `Effect.gen` that gets its dependencies with `yield*`), then `export const layer`. The tag string is `"ponder/<area>/<Name>"`. The service type is `Name["Service"]`, with no separate `NameShape` type.
3. **Dependencies come from the environment.** No module-level clients, pools or singletons. Configuration values and pure helpers can be parameters.
4. **Functions.** A reusable function that returns an Effect is `Effect.fn("Service.operation")(function* (...) {...})`. Keep the span names that exist now (`span("thread.load", ...)` becomes `Effect.fn("thread.load")`), because `server/tracing.check.ts` and `e2e/tests/tracing.spec.ts` read them. Use `Effect.fnUntraced` for per-chunk or per-part work, and say why in a short comment. Do not write a function that only returns `Effect.gen`.
5. **Errors.** Failures are `Schema.TaggedError` classes with bounded fields: an operation, an id, a status or category. The message is fixed or built from those fields. The original error goes in `cause: Schema.Defect()`. Never put message text, file names, tool input or output, URLs with queries, or keys into fields or span attributes (this is Ponder's privacy rule, `server/tracing/privacy.ts`). Handle errors with `Effect.catchTags({...})`. A failure that a person or a caller cannot act on is a defect (`Effect.orDie`).
6. **Validation.** Untrusted data is decoded with `Schema`, not by hand. Use `Predicate` helpers, not your own `isRecord` or `isString`.
7. **Time and waits.** Use `Clock`, `DateTime`, `Duration`, `Effect.sleep`, `Effect.timeout` and `Schedule`. No `setTimeout`, `Date.now()` or `new AbortController()` in services. Where the AI SDK or `fetch` needs an `AbortSignal`, use the signal that `Effect.tryPromise((signal) => ...)` gives, so interruption cancels the call.
8. **Resources.** Anything that must be closed (an MCP client, a worker, a stream writer) uses `Effect.acquireRelease` or `Effect.ensuring`, in a `Scope`.
9. **Logs.** Use `Effect.logWarning` and `Effect.logError`, not `console.warn`. The log text stays the same as now. The logger keeps the trace id in each line (`server/tracing/logs.ts`).
10. **Configuration.** Environment variables are read only through `Config`, in the `PonderConfig` service (`server/config.ts`). No `process.env` in other server modules.
11. **Database.** Use `SqlClient` from `effect/sql` with the `@effect/sql-pg` layer, unless the Phase 0 gate below chooses the fallback. Decode rows with `SqlSchema` and `Schema`. Use `sql.withTransaction` for work that must happen together. Keep the SQL text the same unless a change is needed.
12. **Boundaries.** `runPromise` is used only at the edges, through the helpers in `server/runtime/`:
    - Hono routes: `route(c, effect)`. It runs the effect and maps the tagged errors to HTTP answers.
    - Workflow steps: `runStep(effect)`. Load it with `await import(...)` inside the step, as steps load all their modules now. A failure is thrown as the same kind of error as today. Tagged errors that should stop the run become `FatalError`; those that should run the step again become `RetryableError`.
    - Nitro plugins, worker entry points and check scripts.
    No `runPromise` in a service, a repository or a layer.
13. **One runtime.** `server/runtime/runtime.ts` builds one `ManagedRuntime` from the app layer and keeps it on `globalThis`. The Nitro build has more than one copy of some modules (`.output/server/_chunks/db.mjs`, `db2.mjs`, `db3.mjs`), and every copy must use the same runtime and the same database pool. On SIGTERM, startup disposes the runtime.
14. **Tracing.** Effect spans go through `@effect/opentelemetry` (`OtelTracer.layerGlobal`) to the tracer provider that `server/tracing/setup.ts` registers. So the privacy exporter, the sampler ("only inside a reply's trace") and the durable span ids stay as they are. An Effect span with no Effect parent takes the active OpenTelemetry span as its parent, and the AI SDK's spans nest under Effect spans.
15. **Tests.** New tests are `*.test.ts` files run by `vitest` with `@effect/vitest` (`it.effect`, `it.layer`, `TestClock`). Give test layers only for outside systems: OpenRouter, an MCP server, the clock. Do not mock the logic under test. No sleeps or polling in tests. The existing `*.check.ts` scripts stay and must still pass. Change them only where an API they call has changed.
16. **Comments.** Ponder's code has many comments that explain why. Keep them, and move them with the code. Write new comments in the same style.
17. **No shims.** When a module moves to Effect, update all its callers. Do not keep a Promise copy of a function "for compatibility". The exception is a deliberate boundary in `server/runtime/`.

## Phases

The phases run in order. In a phase with parallel pieces, each piece owns a set of files. A piece may change a file of another piece only at a call site of its own functions, and only with small edits, never by rewriting the file. `server/app.ts` and `server/workflow/steps.ts` are shared in this way.

Implementation agents do not commit. The lead merges, checks and commits at the end of each phase.

### Phase 0: Foundation (one agent)

- `server/runtime/`: the app layer, the `ManagedRuntime` on `globalThis`, `route`, `runStep` and `runMain` for scripts.
- `server/config.ts`: the `PonderConfig` service with every environment variable that the server reads now, with the same defaults.
- The database. **Gate:** try `@effect/sql-pg` against a real Postgres with pgvector, with the queries that Ponder needs: `jsonb` in and out, `tsvector` search, `vector` columns, arrays, `timestamptz` (does it come back as a `Date`?), transactions, and `sql.unsafe` for the migration with the generated column. If it works, use it. If something does not work, write a `Db` service over postgres.js with `Effect.tryPromise`, a `SqlError` and a span for each query, and write the reason in `docs/effect.md`. Then move `server/db.ts` (threads) as the reference repository.
- Tracing: add the `OtelTracer` layer, and a replacement for `server/tracing/span.ts` (`span`, `annotate`, `failed`, `errorType`) that works for Effect code. `server/tracing.check.ts` must pass.
- Logging: a logger that keeps today's format and the trace id.
- Startup: `server/startup.ts` and `server/plugins/*` start and stop the runtime. Migrations become an Effect, with the same SQL.
- `vitest.config.ts`, `npm run test`, a CI step, and one example test for the threads repository.
- `docs/effect.md`: the house rules above, with Ponder examples from this phase.
- The `/health` route as the reference thin route.

### Phase 1: Platform services (one agent)

The services that most domains use: `secrets`, `settings`, `openrouter-key`, `openrouter`, `models`, `auto-router`, `net-guard`, `hosts`, `validate`, `object-store`, `email`, `notify`, `telemetry/*` and `telemetry.ts`. Their callers in other areas are updated in the same phase.

### Phase 2: Domains (four agents in parallel)

| Piece | Files it owns |
| --- | --- |
| 2A Connectors | `server/mcp/*`, `server/workflow/connectors.ts`, `server/workflow/connector-messages.ts` |
| 2B Memory and compaction | `server/memory/*`, `server/memory.ts`, `server/compaction/*` |
| 2C Tools and files | `server/files.ts`, `file-context.ts`, `image-resize.ts`, `pdf-text.ts`, `python/*`, `search/*`, `skills.ts`, `standard-skills.ts`, `standard-skills/*`, `artifacts/*`, `thread-search.ts`, `thread-title.ts`, `thread-cache.ts` |
| 2D People and admin | `server/auth.ts`, `session-cache.ts`, `admins.ts`, `admin-events.ts`, `admin-auth-events.ts`, `invites.ts`, `credits.ts`, `extra-credits.ts`, `rate-limit.ts`, `admin/*`, `boot-page.ts`, `web-build.ts` |

### Phase 3: The reply engine (one agent)

`server/workflow/*` (the rest), with the model attempt (`model-attempt.ts`: the watchdog becomes a stream timeout, the bookkeeping becomes `ensuring`), the replies, runs, approvals and steps. Then `server/app.ts` (every route thin), `server/tracing/*`, the removal of `postgres` and of `span.ts` when nothing uses them, and the check scripts. Last, a sweep: no `process.env`, `console.warn`, `setTimeout` or `.catch(() => undefined)` left in services, other than at a boundary with a reason.

### Phase 4: Full check

Types, the check scripts, the vitest tests and all e2e tests, on a Postgres of our own. Then one review of the whole pull request.

## Checks for each phase

The agent runs these in the worktree, and the lead runs them again before the commit:

```bash
npm run typecheck          # the web app, which reads the server's route types
npm run typecheck:server   # also add new entry points to its file list when needed
npm run typecheck:e2e
npm run test               # vitest (from Phase 0)
npx tsx server/<area>.check.ts   # the check scripts of the area changed
```

The check scripts and the e2e tests need Postgres. Use your own container, never another session's:

```bash
docker run -d --name ponder-effect-pg-$RANDOM --tmpfs /var/lib/postgresql \
  -p 127.0.0.1:<random high port>:5432 -e POSTGRES_USER=ponder -e POSTGRES_PASSWORD=ponder pgvector/pgvector:pg18
```

Remove the container when you are done. For e2e tests, set `E2E_DATABASE_URL` and all five `E2E_*PORT` variables to random high ports (other sessions run e2e on this server too). The root disk has about 1 GB free: do not run `npm ci` or `npm install` in a new place, and do not download big things.

## Review

After each phase, a GPT reviewer (Codex, `gpt-6.1-sol`) reads the phase's diff. It looks for:

- Behavior changes: an answer, a status code, a log line, a span name, a retry or a timeout that is different now.
- Errors that are lost or swallowed, a cleanup that no longer runs, a missing interruption.
- Data or privacy problems: content in span attributes, error fields or logs.
- Breaks of the house rules that matter: a runtime inside a service, a module-level singleton, a Promise shim.

The reviewer reports real bugs only, not style. The implementing agent fixes them. There are at most three review rounds for each phase. Findings that remain after three rounds go to Hussain.

## Status

| Phase | State |
| --- | --- |
| 0 Foundation | Not started |
| 1 Platform services | Not started |
| 2 Domains | Not started |
| 3 Reply engine | Not started |
| 4 Full check | Not started |
