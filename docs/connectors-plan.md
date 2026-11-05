# Ponder Chat: connectors (MCP)

Goal: each person can connect the apps they use, such as Linear, Notion, a Frappe site or any remote MCP server. The model can then use the tools of those apps in a chat. Credentials are encrypted in the database and never go to the browser.

How it works now is in the README, under "Connectors". This file keeps the decisions, what changed from the first plan, what is left, and the risks.

## Status

Built: connectors with no sign-in, with an API key, and with OAuth (dynamic registration, or the person's own app). Rules for each tool, approvals in the chat, and Settings with Account and Connectors. Checked by `server/mcp.check.ts` (14 checks against a test MCP server and OAuth server, and DeepWiki with `--live`), and end to end in a browser: add with OAuth in a popup, a call that waits for approval, Allow once, Always allow, Deny, and Settings on a phone.

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

## Later

- On and off for each chat, from a button in the message field (it is in the prototype).
- The directory: servers that admins add for everyone, with registered OAuth apps, and a switch for custom connectors.
- Tool search when a person has more than about 40 connector tools (`toolSearch` with `deferLoading`; Seva measured its cost in `docs/tool-search.md`).
- Images and resources in results, saved as the person's files. Now they are named, not shown.
- Revoke the token when a connector is removed (RFC 7009), where the server has a revocation endpoint.
- Client ID Metadata Documents, the way to register that the MCP spec prefers now. `@ai-sdk/mcp` reads the flag but does not use it yet.
- Elicitation, and MCP Apps (the SDK has `readMCPAppResource`).

## Risks

- **Prompt injection and data leaks.** A tool result, such as an email or an issue, can tell the model to send private data to a URL with `web_fetch`. Approvals stop changes to the person's apps, but not `web_fetch`. Later: in a turn that read connector data, ask before a `web_fetch` to a page that no search returned.
- **A write can run twice.** When the server crashes during a call, the call step runs again after the restart. `maxRetries = 0` stops retries after an error, not after a crash.
- **Many tools cost tokens on every call.** Three servers with 40 tools each add about 15,000 input tokens to each model call. "Off" and the connector switch help now; tool search is in "Later".
- **A new `BETTER_AUTH_SECRET`** makes credentials sealed with it unreadable, and those connectors ask for a new sign-in or key. Set `PONDER_ENCRYPTION_KEY` before many people connect, to separate the two.
- **One process.** The refresh lock and the client pool are in memory. A second server process needs a Postgres advisory lock instead.
