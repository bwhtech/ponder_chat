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
4. Starts Ponder's build on port 3597. Ponder sends every OpenRouter call and every email to the fake, through `OPENROUTER_BASE_URL` and `CLOUDFLARE_API_URL`.

Python is off, because it needs Deno and Pyodide. To include it, run `npm run sandbox:setup` and set `E2E_PYTHON=1`.

To look at the app as the tests see it, run `npm run e2e:server` and open http://127.0.0.1:3597. Playwright uses that server while it runs, and does not start another one. Sign in with an invited email: the code is in the fake's outbox, at http://127.0.0.1:3598/__fake/emails?to=you@example.com. To invite an email, add it with `npx tsx scripts/invite.ts` and `DATABASE_URL` set to the test database.

## Write a test

Import `test` and `expect` from `e2e/fixtures.ts`. Its fixtures:

| Fixture | What it gives |
| --- | --- |
| `person` | Signs the page in as a new person, with no chats and a full day's credits. |
| `admin` | The same, with the admin role. |
| `fake` | Scripts the fake OpenRouter, and reads what Ponder sent to it. |
| `db` | Ponder's database, for setup that the app can't do, such as an invite. |

Each test gets a new person, so tests can run in parallel and in any order.

### Script a reply

A message that no script matches gets the reply "You said: <the message>". For another reply, send a script before the message. The fake uses the first script whose `match` is in the person's latest message:

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
- `cost`: the cost in US dollars that OpenRouter reports. Credits are charged from it.

`fake.search()` sets the results of a web search. `fake.memory()` sets what memory saves from a turn. `e2e/fake/script.ts` describes each script.

### Check what the model was sent

`fake.calls(match)` returns each chat call for the messages that contain `match`: the model, the system prompt, the messages and the tools. For example, to check that an attached file reached the model:

```ts
const [call] = await fake.calls("attachment test");
expect(JSON.stringify(call.messages)).toContain("pear,7");
```

### Choose good selectors

- Use roles and labels first: `page.getByRole("button", { name: "New chat" })`.
- For the chat, use the `chat` helpers in `fixtures.ts`, such as `chat.send()`, `chat.reply()` and `chat.idle()`. They use the `data-slot` attributes of frappe-ui-ai-elements.
- Each person's email has the test's title in it, and the account menu shows the email. So use `exact: true` for a button name that can be in a title, such as "Retry".

### Add an OpenRouter call to the fake

If Ponder starts to call another OpenRouter endpoint, add a route for it to `e2e/fake/server.ts`. Get its address with `openRouterUrl()` from `server/openrouter.ts`, so that the tests can send it to the fake. The fake logs each request that it has no route for.
