# End-to-end tests

These tests use Ponder as a person does: a real browser on Ponder's build, with a real Postgres. A fake OpenRouter answers every model call, so the tests need no API key and spend nothing. CI runs them on every pull request (`.github/workflows/ci.yml`).

## Run the tests

You need Docker and Node 24.

1. Start a Postgres with pgvector. `--tmpfs` keeps its data in memory, which is faster, and nothing stays after you remove it.

   ```bash
   docker run -d --name ponder-e2e-pg --tmpfs /var/lib/postgresql -p 127.0.0.1:55433:5432 \
     -e POSTGRES_USER=ponder -e POSTGRES_PASSWORD=ponder pgvector/pgvector:pg18
   ```

2. Install Chromium for Playwright, once: `npx playwright install chromium`.

3. Build Ponder and run the tests: `npm run e2e`.

   After a change to the tests only, run `npx playwright test`. That skips the build.

Useful options:

| Command | What it does |
| --- | --- |
| `npx playwright test chat` | Runs the files whose name contains "chat". |
| `npx playwright test -g "Stop"` | Runs the tests whose title contains "Stop". |
| `npx playwright test --ui` | Opens Playwright's UI, to watch each step. |
| `npx playwright show-report` | Shows the last report, with a trace for each failed test. |

To use another Postgres, set `E2E_DATABASE_URL`. The database's name must end in `_e2e`, because each run drops it and makes it again.

## What runs

`playwright.config.ts` starts `e2e/start.ts` before the tests. It:

1. Drops the test database and makes it again.
2. Creates the workflow's tables (`npx bootstrap`).
3. Starts the fake OpenRouter (`e2e/fake/server.ts`) on port 3598.
4. Starts the test MCP servers (`e2e/mcp/server.ts`) on ports 3599 and 3600.
5. Starts Ponder's build on port 3597. Ponder sends every OpenRouter call and every email to the fake, through `OPENROUTER_BASE_URL` and `CLOUDFLARE_API_URL`. `MCP_ALLOW_PRIVATE_NETWORKS=1` lets connectors reach the test MCP servers on 127.0.0.1.

Tracing is on, and Ponder sends its traces to the fake, at `/v1/traces`. `fake.spans()` reads them (`tests/tracing.spec.ts`). To see the tests' traces in a local Jaeger instead, set `E2E_OTEL_ENDPOINT=http://127.0.0.1:4318` (README, "Tracing"). Then `tracing.spec.ts` fails, because the fake gets no spans.

The durability tests (`tests/durability-*.spec.ts`, helpers in `e2e/durability.ts`) stop a Ponder with SIGKILL and SIGTERM in the middle of a reply, and start it again. One server runs the workflow worker of a database, so each of these files starts its own Ponder, with its own database `ponder_durability_<name>_e2e` on the same Postgres. The first file's server is on port 3596 (`E2E_DURABILITY_PORT`), and the others are on the ports below it. A file's tests run one at a time. The files run side by side.

Python is off, because it needs Deno and Pyodide. To include it, run `npm run sandbox:setup` and set `E2E_PYTHON=1`.

To look at the app as the tests see it, run `npm run e2e:server` and open http://127.0.0.1:3597. Playwright uses that server while it runs, and does not start another one. Sign in with an invited email: the code is in the fake's outbox, at http://127.0.0.1:3598/__fake/emails?to=you@example.com. To invite an email, add it with `npx tsx scripts/invite.ts` and `DATABASE_URL` set to the test database.

## Write a test

Import `test` and `expect` from `e2e/fixtures.ts`. Its fixtures:

| Fixture | What it gives |
| --- | --- |
| `person` | Signs the page in as a new person, with no chats and a full day's credits. |
| `admin` | The same, with the admin role. |
| `fake` | Scripts the fake OpenRouter, and reads what Ponder sent to it, traces included. |
| `db` | Ponder's database, for setup that the app can't do, such as an invite. |

Each test gets a new person, so tests can run in parallel and in any order.

### Script a reply

A message that no script matches gets the reply "You said: <the message>". For another reply, send a script before the message. The fake uses the newest script whose `match` is in the person's latest message, so a test can replace a script by sending another. Make each `match` unique to its test: a script stays in the fake until it stops, and a `match` that is part of another test's message would answer that message too. For example:

```ts
await fake.chat({ match: "planets", steps: [{ text: "| Planet | Moons |\n| --- | --- |\n| Mars | 2 |" }] });
await chat.send(page, "Show me the planets");
await expect(chat.reply(page).locator("table")).toContainText("Mars");
```

Each model call in a turn uses the next step. A reply that calls a tool has two steps: the tool call, then the answer after the tool ran:

```ts
await fake.chat({
	match: "packing list",
	steps: [
		{ toolCalls: [{ name: "write_artifact", input: { id: "packing-list", kind: "document", title: "Packing list", content: "- Sun hat" } }] },
		{ text: "I wrote a packing list." },
	],
});
```

A step can also have:

- `reasoning`: thinking, streamed before the text.
- `delayMs`: the time between streamed pieces. A large value keeps the reply open, such as to test Stop.
- `error`: an HTTP status and a message, in place of a reply.
- `failFirst`: only the first this many calls of the step fail. The calls after them answer. Ponder tries a failed model call again with the same messages, so each attempt is a call of the same step.
- `breakAfter`: a failing call streams this many pieces, then an error chunk, as a provider that fails in the middle of a reply does.
- `cost`: the cost in US dollars that OpenRouter reports. Credits are charged from it.

`fake.search()` sets the results of a web search. `fake.memory()` sets what memory saves from a turn. `e2e/fake/script.ts` describes each script.

### Check what the model was sent

`fake.calls(match)` returns each chat call for the messages that contain `match`: the model, the system prompt, the messages and the tools. For example, to check that an attached file reached the model:

```ts
const [call] = await fake.calls("attachment test");
expect(JSON.stringify(call.messages)).toContain("pear,7");
```

### Test a connector

`e2e/mcp/server.ts` has MCP servers made with the official MCP SDK (`@modelcontextprotocol/sdk`). Each one has the tools `find_order`, which only reads, and `add_note`, which changes something, so Ponder asks before it runs `add_note`.

| Address | Sign-in |
| --- | --- |
| `http://127.0.0.1:3599/open/mcp` | None. |
| `http://127.0.0.1:3599/key/mcp` | The header `Authorization: Bearer shop-key`. |
| `http://127.0.0.1:3600/mcp` | OAuth, with dynamic client registration. Its sign-in page says yes at once. |

The model calls a connector's tool through `connector_call`, with the tool's name `<slug>__<tool>`. The slug comes from the connector's name. For a connector named "Shop":

```ts
const call = { name: "connector_call", input: { tool: "shop__find_order", input: { order } } };
await fake.chat({ match: order, steps: [{ toolCalls: [call] }, { text: "It shipped." }] });
```

To search first, add a step with `{ name: "connector_search", input: { query: "find order" } }`.

`GET http://127.0.0.1:3599/__mcp/calls?match=<text>` lists the tool calls that the servers ran, with their arguments. All tests share the servers, so put a value that is unique to the test in the arguments, such as an order number, and match on it. `e2e/tests/connectors.spec.ts` has examples.

CI also runs `server/mcp.check.ts`, which checks what the browser can't reach, such as token refresh and the private-network guard.

### Choose good selectors

- Use roles and labels first: `page.getByRole("button", { name: "New chat" })`.
- For the chat, use the `chat` helpers in `fixtures.ts`, such as `chat.send()`, `chat.reply()` and `chat.idle()`. They use the `data-slot` attributes of frappe-ui-ai-elements.
- Each person's email has the test's title in it, and the account menu shows the email. So use `exact: true` for a button name that can be in a title, such as "Retry".

### Add an OpenRouter call to the fake

If Ponder starts to call another OpenRouter endpoint, add a route for it to `e2e/fake/server.ts`. Get its address with the `url()` of the `OpenRouter` service (`server/openrouter/OpenRouter.ts`), so that the tests can send it to the fake. The fake logs each request that it has no route for.
