# Ponder Chat: connectors (MCP)

Goal: each person can connect the apps they use, such as Linear, Notion, a Frappe site or any remote MCP server. The model can then use the tools of those apps in a chat. Credentials are encrypted in the database and never go to the browser.

How it works now is in the README, under "Connectors". This file keeps the decisions, what changed from the first plan, what is left, and the risks.

## Status

Built: connectors with no sign-in, with an API key, and with OAuth (dynamic registration, or the person's own app). Rules for each tool, approvals in the chat, and Settings with Account and Connectors. Checked by `server/mcp.check.ts` (14 checks against a test MCP server and OAuth server, and DeepWiki with `--live`), and end to end in a browser: add with OAuth in a popup, a call that waits for approval, Allow once, Always allow, Deny, and Settings on a phone.

Tool search is built: connector tools reach the model through `connector_search` and `connector_call` (see "Tool search" below). It is checked by `server/connector-catalog.check.ts` and the connector tests in `e2e/tests/connectors.spec.ts`.

Not built yet: see "Later".

## Words

| Word | Meaning |
| --- | --- |
| Connection | One person's link to one MCP server: its URL, transport, credentials, tools and the rule for each tool. A row in `mcp_connections`. |
| Connector | What the person sees in the UI: a connection. The UI uses only this word. |
| Rule | What Ponder does before it uses a tool: "Always allow", "Ask first" or "Off". |

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| Client library | `@ai-sdk/mcp`, pinned to an exact version (2.0.91). Only `server/mcp/client.ts` and `server/mcp/oauth.ts` import it. | It has the full OAuth 2.1 flow that the MCP spec asks for. The package changes often, so only two files depend on it. |
| Transports | Streamable HTTP, and SSE for old servers. No stdio. | Stdio runs a command on our server. A shared server must not run commands that people type. |
| Sign-in methods | None, headers (an API key), OAuth | These cover the remote MCP servers in use now. |
| OAuth client | Dynamic client registration, or the person's own app (client ID and secret, under Advanced) | GitHub, Google and Slack do not allow dynamic registration. |
| Where credentials are | One sealed JSON value for each connection | One value to encrypt and to delete. What is not secret (status, expiry, tools, rules) is in plain columns. |
| Encryption | `seal` and `unseal` in `secrets.ts`, with the table, the row id and the column as AAD. The key is `PONDER_ENCRYPTION_KEY`, or else derived from `BETTER_AUTH_SECRET`. | A value copied to another row does not decrypt. Each sealed value names its key, so the key can move to `PONDER_ENCRYPTION_KEY` later. |
| Outbound requests | The `web_fetch` guard, shared (`net-guard.ts`): https, public addresses only, checked on each connection, no redirects for MCP requests | People type the URLs. Without the guard, a URL could reach the tailnet or this machine. |
| Tool names | `<slug>__<tool>`, at most 64 characters | Two servers can have tools with the same name. Most providers allow 64 characters. |
| How the model gets the tools | A catalog: `connector_search` and `connector_call`, never one tool for each connector tool | The tool list and the instructions stay the same when connectors change, so the provider's cache keeps them. A person can have hundreds of tools. |
| Search | Keyword ranking in tiers, as in vercel/eve. No embeddings. | A person's catalog is hundreds of tools at most. Pure code runs inside the workflow, so a replay gets the same results, with no step, no network and no cost. |
| Input check | Ajv against the real tool's schema, in `connector_call`'s own validator | The person is never asked to approve a call that can't run. The options are WorkflowAgent's, so a call passes or fails as it did before. |
| Default rules | `readOnlyHint` gives "Always allow"; every other tool gets "Ask first" | A change to the person's apps needs their approval. Annotations are hints, so each rule can be changed. |
| Calls in a reply | One step records the tools; each call is a step with `maxRetries = 0` that never throws | A live client can't cross a step boundary. A retried call could create something twice. |
| Approvals | `needsApproval` as a function, signed approval requests | See "What changed from the plan". |
| Token refresh | Before a call, when the token expires within a minute; one refresh at a time per connection, in memory | Two calls at once must not both use a refresh token that the server rotates. One process runs Ponder. |

## Database

```sql
mcp_connections (
	id, user_id → users on delete cascade,
	name, slug,                          -- slug: the start of each tool name; never changes
	url, transport ('http' | 'sse'), auth ('none' | 'headers' | 'oauth'),
	status ('connected' | 'needs_sign_in' | 'error'), enabled,
	credentials,                         -- sealed JSON: headers, OAuth client, tokens, the authorization server pin
	header_names, oauth_client_id,       -- what the page may show
	expires_at, server_info, tools, tools_checked_at, tool_rules, last_error, last_used_at,
	unique (user_id, slug), unique (user_id, url)
)
mcp_sign_ins (state_hash, user_id, connection_id, secret, expires_at)   -- OAuth sign-ins in progress, 10 minutes
thread_runs.message_id, thread_runs.base_parts                          -- the message a run carries on
```

## What changed from the plan

- **No directory.** The first plan had a list of servers that admins add for everyone, with registered OAuth apps, in its own table. It is left for later, so one table holds everything. When it comes, add `mcp_servers` and a `server_id` on connections.
- **A run after an approval keeps the message's id.** After the person answers, the page sends the thread again and a new run carries on the last assistant message. Each run used its own message id, and a reader of the stream starts a new message when the id changes, so the reply was lost. Now the route records the message the run continues and how many parts it had (`thread_runs`), the stream keeps that message's id, and saving rebuilds the message from those parts, so saving twice adds nothing twice.
- **`needsApproval` is a function.** "Always allow" saves the rule before the approved call runs. WorkflowAgent refuses to run an approved call for a tool that does not need approval, so a tool on "allow" with `needsApproval: false` failed. A function that returns the rule as it was when the reply started is never `false` to that check.
- **Settings on a phone.** frappe-ui's `SettingsDialog` fills a phone's screen, but the `Dialog` around it keeps its padding, so it ran off the right side. `web/style.css` fixes this on phones, `web/settings/PanelHeader.vue` and `PanelBody.vue` replace `SettingsHeader` and `SettingsBody` (which pad 4.4rem on every screen) and add the scroll fade, and a close button shows on phones. These belong in frappe-ui.
- **Denied steps.** The step summary counted a call the person denied as a change. It now says "skipped 1 denied step".

## Tool search

The first version gave the model every enabled connector tool as a tool of its own, at most 120, on every call. Three servers with 40 tools each added about 15,000 input tokens to each call. The connector names and the servers' notes were in the instructions. Connecting, changing or removing a connector changed the start of the prompt, so the provider's cache missed for everything after it.

Now the model gets two tools, based on vercel/eve's deferred tool catalog:

- `connector_search({ query, limit })` returns the best matches: each tool's exact name, its description, a TypeScript-like signature of its input, and whether it asks first. Results also carry the notes of the matching connectors' servers.
- `connector_call({ tool, input })` calls one tool. Its own validator checks `input` against the tool's schema first. `needsApproval` returns the real tool's rule.

The answers to the questions the design had to settle:

- **What the model sees first.** The instructions have one fixed paragraph that names no connector. A `<connectors>` note with the person's latest message names their connectors, as memory's note does. The latest turn is sent uncached anyway. With few tools (all their lines fit in 3,000 characters), the note lists each tool's signature, so the model calls it without a search.
- **No threshold for the tool list.** Keeping a few tools as tools of their own would change the tool list when tools come and go, and would mean two ways to call a tool, each with its own approvals. The note gives the same benefit without either.
- **No "found tools" state.** A search does not make tools callable. Every call goes through `connector_call`, so the tool list never changes in a reply. The catalog is recorded by one step, and search and the input check are pure, so a replay is the same.
- **Approvals.** The signature covers the whole input, so the real tool's name and its input too. The check and `needsApproval` find the tool by the same exact name, and `needsApproval` asks when it finds none. A review found that a name with a space added passed a check that trimmed it, while `needsApproval` found no tool and did not ask. The call step now also reads the rule again and refuses a tool on "Ask first" unless the person approved this call. A second review found that this guard first took "approved" from the catalog's own rule, so it was true for every "Ask first" tool and did not catch the padded name. It now takes it from the messages (`approvedIn` in `server/workflow/connector-messages.ts`): the latest assistant message with this call id must hold a `connector_call` with the same input and its approval request, and a later tool message must approve it, with no denial. A third review asked for the input and the order, because some providers reuse call ids from turn to turn. After an approval, the run that carries on reads the catalog again: a tool turned off or removed in the meantime fails the check, and the call does not run.
- **A connector that is down.** A connector whose sign-in ended or whose server fails stays in the catalog with no tools. Otherwise the person's last connector going down would take the two tools and the instructions out of the prompt, and the cache would miss.
- **The chat page.** frappe-ui-ai-elements 1.2.0 gives the tool labeler the part, so `connector_call` shows as "Linear · Create issue", its card asks about that tool and shows its input, and the folded summary counts reads and changes by the tool's `readOnlyHint`.

## Later

- On and off for each chat, from a button in the message field (it is in the prototype).
- The directory: servers that admins add for everyone, with registered OAuth apps, and a switch for custom connectors.
- Images and resources in results, saved as the person's files. Now they are named, not shown.
- Revoke the token when a connector is removed (RFC 7009), where the server has a revocation endpoint.
- Client ID Metadata Documents, the way to register that the MCP spec prefers now. `@ai-sdk/mcp` reads the flag but does not use it yet.
- Elicitation, and MCP Apps (the SDK has `readMCPAppResource`).

## Risks

- **Prompt injection and data leaks.** A tool result, such as an email or an issue, can tell the model to send private data out in an address. `web_fetch` now asks first for an address that the person did not give and no search returned, and the page policy stops images from other sites in replies (README, "Prompt injection"). A link that the person clicks can still carry data.
- **A write can run twice.** When the server crashes during a call, the call step runs again after the restart. `maxRetries = 0` stops retries after an error, not after a crash.
- **A tool that the model does not find.** Search ranks by keywords. A tool whose name and description share no words with the request can rank low. The model can list a connector's tools with `<slug>__`, and with few tools the note lists them all.
- **A new `BETTER_AUTH_SECRET`** makes credentials sealed with it unreadable, and those connectors ask for a new sign-in or key. Set `PONDER_ENCRYPTION_KEY` before many people connect, to separate the two.
- **One process.** The refresh lock and the client pool are in memory. A second server process needs a Postgres advisory lock instead.
