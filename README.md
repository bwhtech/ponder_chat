# Ponder Chat

A proof of concept: a general chat app on OpenRouter models, with a daily credit limit for each person. It started as a copy of the Seva platform (`~/.t3/projects/seva-studio/platform`) with the Frappe parts removed (sites, MCP, skills, plans, Studio, generated UI). Python and memory came back later, adapted.

## What it does

- Sign-in with an email link (Better Auth). Without email settings, the link is printed in the server log.
- Chats in a sidebar, with names that a cheap model writes.
- A model selector in the message field. The list is in `server/models.ts`, and it is also the allowlist: a request for any other model gets the default.
- Each reply shows the model that wrote it.
- Privacy: every OpenRouter call (replies, names, memory, embeddings) asks for Zero Data Retention endpoints only (`server/openrouter.ts`), so no provider keeps or trains on what people write. The selector shows only the models that have such an endpoint, from OpenRouter's public list. OpenRouter's own PDF parser is not covered by this rule.
- Attached images, PDFs and text files go to the model. Each file is private to the person who attached it: the download link, the model and Python read only the owner's files.
- A click on an attached PDF or image opens it over the chat (`web/ai-elements/file-viewer/`). pdf.js loads only the first time a PDF opens, and each page draws when it comes near the screen. Cmd- or Ctrl-click still opens the file in a new tab.
- Each reply is a durable workflow run (Workflow SDK, Postgres World). A reload, a dropped connection, a deploy or a crash does not end it: the page reconnects and the reply finishes. Messages sent during a reply wait in a queue.
- Python: the model can run Python (pandas, matplotlib and more) in a Pyodide sandbox. Attached CSV and Excel files go in as inputs; charts and files come back into the chat.
- Web search: the model can search the web (`web_search`) and read a page (`web_fetch`). See "Web search" below.
- Memory across chats: after each reply, Ponder decides whether the person said something about themselves worth keeping. A note under the reply shows what it kept, with Undo, and the Memory page lists every memory and decision. See `docs/memory.md`.
- Daily credits (see below).

## Credits

| Setting | Default | Meaning |
| --- | --- | --- |
| `CHAT_DAILY_CREDITS` | 1000 | Credits for each person each day. |
| `CHAT_CREDITS_PER_USD` | 1000 | Credits per US dollar of OpenRouter cost. With 1000, one credit is $0.001. |

- Credits are charged from the cost that OpenRouter reports for each call. The `runs` table records it (`server/telemetry/`).
- The calls that write chat names are recorded in `runs` but are not charged to credits.
- Each web search is a `runs` row (`function_id` `web-search`) and is charged: about $0.007, so 7 credits.
- The count starts again at midnight UTC.
- Before each reply, the server adds up today's cost. When nothing is left, it answers 402 and the page shows when credits refill.
- Nothing is reserved before a reply. The last reply of the day can go a little past the limit.
- To give one person a different limit, run on the server with the app's environment: `npx tsx scripts/credits.ts set someone@example.org 3000`. `reset <email>` puts them back on the default; `list` shows who has their own limit.
- PDFs: a model that can't read PDFs itself gets them through OpenRouter's free `cloudflare-ai` parser, not its default paid OCR. Each PDF is parsed again on every call.

## Durable replies

| Part | Where |
| --- | --- |
| The workflow: one reply, each model call and tool call a step | `server/workflow/chat.ts`, `server/workflow/steps.ts` |
| The model, serializable across steps | `server/workflow/model.ts` |
| Streams, reconnects, saving the reply | `server/workflow/reply.ts`, `server/workflow/runs.ts` |
| Start-up and shutdown of the worker | `server/startup.ts` |
| Browser: reconnects with `WorkflowChatTransport` | `web/ChatView.vue` |

- Nitro builds the server (`nitro.config.ts`) and compiles `"use workflow"` and `"use step"`. Runs are stored in Postgres (schemas `workflow` and `graphile_worker`); `npx --no-install bootstrap` creates them, and again after an upgrade of `@workflow/world-postgres`.
- `@ai-sdk/workflow` does not retry a model call whose server stopped. `scripts/patch-workflow-retries.mjs` (run after `npm install`) lets it retry twice; each attempt starts with `reset-step`, so the page drops the partial text. The script fails if a new version changes that code.
- One server runs the worker. At start-up it waits for an advisory lock until the previous server is gone, then releases the jobs a crash left locked (graphile-worker otherwise waits 4 hours). On SIGTERM it stops the worker and exits.
- The flow route `/.well-known/workflow/v1/flow` has no authentication. The server listens on 127.0.0.1; in production the proxy must refuse that path.
- Stop cancels the run and saves what it wrote. The model call in flight still runs to its end on OpenRouter; that cost is not charged to credits.

## Python

`sandbox/pyodide/` is adapted from LangChain's pyodide-sandbox (MIT): each run is a new Deno process with no permissions except reading Pyodide and the vendored packages. No network, no environment, no writes, no subprocesses. Variables, imports and files in `/work` are kept per chat in Postgres (`python_state`). Set up once with `npm run sandbox:setup` (needs Deno and uv). Limits: `PYTHON_MAX_RUNS` (3 at once), `PYTHON_MEMORY_MB` (1536), 60 seconds a run.

## Web search

The model sees two tools of our own (`server/search/schema.ts`), whatever runs them behind:

- `web_search`: a backend from `SEARCH_BACKEND` (`server/search/backend.ts`). The only one now is `openrouter`: a cheap model (`PONDER_SEARCH_MODEL`) makes one search with OpenRouter's `web_search` server tool on Exa, and its citations are the results. It needs no other API key. The model call goes to a Zero Data Retention endpoint, but Exa keeps queries by its own rules. For more privacy later: a search API with a zero-retention contract (Brave, Exa or Parallel enterprise) or a SearXNG we host, as one more backend.
- `web_fetch`: reads the page on our own server (`server/search/fetch-page.ts`), so no other company sees it. It refuses every address on this machine, the tailnet and private networks, checked when each connection opens and on each redirect. Only ports 80 and 443; at most 3 MB and 20,000 characters of text.

## Run it

Secrets are in `~/.config/ponder-chat/.env` (mode 600): `DATABASE_URL` (database `ponder_chat`), `OPENROUTER_API_KEY`, `BETTER_AUTH_SECRET`, `PONDER_HOSTS`, and the credit settings.

```bash
npm install
npm run sandbox:setup                                  # once: Pyodide and its packages
set -a; . ~/.config/ponder-chat/.env; set +a
WORKFLOW_POSTGRES_URL=$DATABASE_URL npx --no-install bootstrap   # once, and after upgrades
npm run build
./start.sh        # http://127.0.0.1:3500
```

Checks: `npm run typecheck` (web), `npm run typecheck:server`, `npx tsx server/memory.check.ts`, and `npx tsx server/search.check.ts [--live]`.

## Code

| Part | Where |
| --- | --- |
| HTTP API | `server/app.ts` |
| Chat workflow | `server/workflow/` |
| Python tool and sandbox | `server/python/`, `sandbox/pyodide/` |
| Models | `server/models.ts`, `web/models.ts` |
| Credits | `server/credits.ts`, `web/CreditMeter.vue` |
| Memory | `server/memory.ts`, `server/memory/`, `web/MemoryView.vue` |
| Chat page | `web/ChatView.vue`, `web/Workspace.vue` |
| Components | `web/ai-elements/` (copy of the platform's) |
