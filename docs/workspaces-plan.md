# Ponder Chat: workspaces

Goal: a person collects instructions and documents in a workspace, then asks questions that are answered from them. A workspace is for one person, for people they choose, or for the whole organisation.

The design comes from the prototype at https://sketch.netchamp.dev/u/nagariahussain/ponder-workspaces (version 6). This file keeps the decisions, the plan for each pull request, and the risks.

## Status

Planned. Nothing is built.

## Words

| Word | Meaning |
| --- | --- |
| Workspace | A name, a description, instructions and documents. A chat can belong to one workspace. |
| Organisation workspace | A workspace that everyone can use. Only an admin makes one. |
| Private workspace | A workspace that only its owner and the people they add can use. Anyone makes one. |
| Owner | The person who made the workspace. |
| Member | A person the owner added. Each member can ask, or can ask and edit. |
| Editor | A member who can edit. In an organisation workspace, the people listed are editors, because everyone can already ask. |
| Document | A file in a workspace. Its text is kept in the database. |
| Passage | A part of a document's text, about 1,000 characters, with its embedding. The unit that search returns. |

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| Teams | None. The owner adds people one by one. | An internal tool with tens of people does not need teams yet. Teams can come later without changing this model. |
| Who makes what | An admin makes organisation workspaces. Anyone makes private workspaces. | Org-wide content needs one person who is responsible for it. |
| Finding people | `GET /api/people?q=` searches every account by name or email, for any signed-in person. | Everyone in the organisation can see everyone. The prototype's people picker needs it. |
| Chats | A chat stays private to the person who wrote it, also in a shared workspace. Members share instructions and documents, never chats. | The privacy rule that admins see usage only must also hold for workspace owners. |
| Admins | An admin edits organisation workspaces. An admin cannot open a private workspace unless its owner adds them. | Same reason. The admin page shows counts of private workspaces only. |
| One workspace for each chat | The first message sets it. It never changes. | The instructions are in the cached system prompt. A change would make the answers before it hard to explain. |
| Lost access | The server checks access on each message. A person who was removed can still read the chat, but cannot send in it. | Access is the owner's decision, and it must take effect at once. |
| Deleting a workspace | Its documents and passages are deleted. Its chats stay, and are no longer in a workspace. | A member's chats belong to the member, not to the owner. |
| URL | `/?w=<id>`, the same way `?t=<id>` opens a chat | The chat page has no router, and the server serves it only at `/`. |
| Code name | `web/Workspace.vue` (the signed-in layout) becomes `web/Shell.vue`. | The word "workspace" must have one meaning in the code. |
| Connectors | Later. In a workspace chat, the model uses the person's own connectors, as it does now. | A connector's credentials are in the owner's row. A shared connector with one sign-in for each member needs a new table (see "Later"). |
| Web search | It stays on in workspace chats. The workspace guidance tells the model to answer from the documents first and to say when they do not have the answer. | Ponder has no web search switch now. A strict "workspace only" mode with a "Search the web" button is in "Later". |

## Documents: what Frappe Flow does

Frappe Flow is now part of Frappe (`frappe/flow/knowledge` on `develop`, read on 16 November 2026). It has two paths.

Knowledge bases, which admins curate:

1. A source is extracted to text: PDF, DOCX, XLSX, HTML, plain text, a URL or DocType rows.
2. The text is split into chunks of 1,000 characters with an overlap of 200, at a space or a line break where it can.
3. Each chunk is embedded with the model in Flow Knowledge Settings, 96 at a time.
4. The text is in MariaDB. The search index is a SQLite file with `sqlite-vec` for vectors and FTS5 for keywords. The index can be built again from the text. Flow moved from LanceDB to SQLite on 14 November 2026.
5. A search takes the nearest chunks by cosine distance, and the best keyword matches (stop words left out). It merges the two lists with reciprocal rank fusion (k = 60).
6. The model gets a `search_knowledge(query)` tool that returns the best 5 chunks. The knowledge bases come from the agent's settings, and the model cannot choose them. An empty scope fails, and only knowledge bases that are on are searched.
7. Indexing runs as a background job, one job for each source at a time. The source shows Processing, Completed or Failed.
8. The embedding model cannot change while chunks exist, and a different vector width is an error.

Attachments in a chat:

1. The exact text of each file goes into the turn when all the files fit in half of the model's context window, at 4 characters for each token.
2. When they do not fit, the largest files go to search first, until the rest fit.
3. For files in search, the 8 best chunks for the person's message go into the turn as excerpts.

## Documents: what Ponder does

Ponder uses the same steps, with Postgres in place of MariaDB and SQLite. Memory already does hybrid search this way (`server/memory/pgvector-index.ts`): pgvector, `to_tsvector('simple', …)` and reciprocal rank fusion. Embeddings use `PONDER_EMBEDDING_MODEL` through OpenRouter.

1. **Upload.** `POST /api/workspaces/:id/documents` takes the same file types and the same 10 MB limit as a chat attachment: PDF, text, Markdown, CSV, TSV and JSON. The bytes go to the object store under `workspaces/<id>/<document>`. DOCX and spreadsheets are in "Later".
2. **Extract.** The PDF text reader in `server/pdf-text.ts` reads the text once. The text is kept in `workspace_documents.text`.
3. **Index.** A workflow run splits the text into passages (1,000 characters, 200 overlap, Flow's chunker), embeds them in batches of 96, and saves them in one transaction. The document shows "Reading" until the run ends, then "Ready" or "Failed".
4. **Choose inline or search, on each turn.** Use Flow's attachment rule. When the text of all ready documents fits in half of the model's context window, all of it goes into the system prompt as `<document name="…">` blocks. Otherwise, the largest documents move to search until the rest fit. The existing limit of 300,000 characters for files in one call also applies.
5. **Search.** For documents in search, the 8 best passages for the person's message go into the latest message as a `<workspace_excerpts>` block, the way memory adds `<memory>`. The model also gets a `workspace_search(query)` tool for more searches. The server binds the tool to the chat's workspace, so the model cannot search another one.
6. **Model change.** Each passage stores the embedding model that made it. Search reads only passages from the current model. When the model changes, a check at startup indexes the old documents again.

Instructions and inline documents stay the same during a chat, so the provider's prompt cache keeps them. Excerpts change on each message, so they go in the latest message, outside the cache.

## Database

```sql
workspaces (
	id, kind ('org' | 'private'), owner_id → users,
	name, description, instructions, icon,
	created_at, updated_at, deleted_at
)
workspace_members (
	workspace_id → workspaces on delete cascade, user_id → users on delete cascade,
	access ('ask' | 'edit'), added_by, added_at,
	primary key (workspace_id, user_id)
)
workspace_documents (
	id, workspace_id → workspaces on delete cascade,
	name, media_type, size, object_key, text,
	status ('reading' | 'ready' | 'failed'), error, added_by, created_at
)
workspace_passages (
	id, document_id → workspace_documents on delete cascade, workspace_id,
	ordinal, content, embedding vector, model
)
threads.workspace_id               -- null for a chat outside a workspace
```

The tables are made in a `migrate` effect in a new `Workspaces` service, added to `migrateAll` after `Auth` and `Threads` (`server/startup.ts`).

Access is in one function, `Workspaces.accessOf(userId, workspaceId)`. It returns `none`, `ask`, `edit` or `owner`:

| Workspace | Owner | Member | Admin | Anyone else |
| --- | --- | --- | --- | --- |
| Organisation | `owner` | `edit` (editors) | `edit` | `ask` |
| Private | `owner` | `ask` or `edit` | `none`, unless added | `none` |

Only the owner changes the members of a private workspace. Only an admin changes an organisation workspace's editors, or changes its kind. Every read and write of a workspace, a document or a passage goes through `accessOf`.

## API

| Route | Who |
| --- | --- |
| `GET /api/workspaces` | The workspaces the person can use, for the sidebar. Also in the boot data. |
| `POST /api/workspaces` | Anyone for `private`. Admins only for `org`. |
| `GET /api/workspaces/:id` | `ask` and above. Members are in the answer only for a person who can change them. |
| `PATCH /api/workspaces/:id` | `edit` and above: name, description, instructions |
| `PUT /api/workspaces/:id/sharing` | The owner of a private workspace, or an admin for an organisation workspace: kind and members |
| `DELETE /api/workspaces/:id` | The owner of a private workspace, or an admin for an organisation workspace |
| `POST /api/workspaces/:id/documents`, `DELETE /api/workspaces/:id/documents/:doc` | `edit` and above |
| `GET /api/people?q=` | Any signed-in person. At most 20 results, with id, name and email. |
| `POST /api/chat` | The body gets `workspaceId`, read only on the first message. |
| `GET /api/admin/workspaces` | Admins: organisation workspaces, and counts of private ones |

A workspace that the person cannot use answers 404, never 403, so a request does not show that the workspace exists. Changes to organisation workspaces go to the audit log (`admin_events`).

## Chat turn

1. `startRun` (`server/workflow/replies.ts`) reads the chat's workspace, checks `accessOf`, and puts `workspaceId` in `ChatTurn`.
2. A new step, `workspaceContextStep`, returns the instructions, the inline documents and the excerpts. It is a step because workflow code cannot read the database.
3. `chat.ts` adds the instructions, the inline documents and a fixed `WORKSPACE_GUIDANCE` text to the system prompt. The guidance says: answer from the workspace first, name the document you used, and say so when the workspace does not have the answer.
4. `thread-messages.ts` adds `<workspace_excerpts>` to the latest message.
5. The `workspace_search` tool is added only when the workspace has documents in search.

## Web

- **Layout.** Rename `Workspace.vue` to `Shell.vue`. Add a "Workspaces" section above "Chats" in `ChatsPanel.vue`, and the same rows in `SidebarPlaceholder.vue`, so nothing moves when the panel loads.
- **Sidebar rows.** Organisation workspaces first, then workspaces that others shared, then the person's own. Each row has an icon for its kind: a building, people, or a lock.
- **Chats list.** "Chats" shows only chats outside a workspace. A workspace's chats are on its page. Search finds all chats.
- **Workspace page (`?w=<id>`).** A header with the name, the "Shared with" badge, Share (for the owner, and for admins on organisation workspaces) and a menu. Then the composer, "Your chats here", and a side panel with instructions, documents and "Shared with". On a phone, the side panel goes under the chats.
- **Composer.** A workspace chip goes in `PromptInputTools`, beside the model selector. A new chat can pick a workspace. In a chat that has one, the chip shows its name and cannot change.
- **Dialogs.** New workspace and Share, each loaded on first use with a `DialogFrame` placeholder, as Settings is. The people picker is frappe-ui's `Combobox` with `filterable: false`. It calls `/api/people` and shows the name with the email under it.
- **Admin.** A "Workspaces" page at `/admin/workspaces`. Add it in three places: `router.ts`, the navigation in `App.vue`, and the boot navigation in `admin.html`.
- **Rules.** Follow the ponder-ui skill: loading, empty and error states for each list, no layout shift on load, screenshots at 1440×900 and 390×844 in light and dark.

## Pull requests

1. **Workspaces and sharing.** The tables without documents, `accessOf`, the API, people search, `threads.workspace_id`, instructions in the prompt, the rename to `Shell.vue`, the sidebar, the workspace page, the dialogs and the composer chip. A person can make a workspace with instructions, share it, and chat in it.
2. **Documents.** Upload, text extraction, the indexing workflow, inline or search on each turn, `workspace_search`, and the Reading, Ready and Failed states.
3. **Admin page.** `/admin/workspaces`, and audit events for organisation workspaces.

Each pull request ships alone, and each one updates the README. The first one also changes the "no organisation" lines in `docs/pilot-plan.md` and `docs/memory.md`.

## Tests

- **Unit tests** (`*.test.ts`, with `TEST_DATABASE_URL`):
  - Every cell of the access table.
  - Sharing changes, and a member who loses access.
  - People search.
  - The chunker, and the order of hybrid search results.
  - The inline or search choice at the edge of the budget.
- **End-to-end** (`e2e/tests/workspaces.spec.ts`):
  1. Person A makes a private workspace and shares it with B.
  2. B sees it in the sidebar and asks a question that uses its instructions.
  3. C gets "not found" for the same URL.
  4. A cannot read B's chat in the workspace.
  5. A removes B, and B can no longer send in that chat.
  6. An admin makes an organisation workspace, and every person sees it.
  7. A document goes from Reading to Ready, and an answer uses one of its passages.
- **Embeddings in end-to-end tests.** The fake OpenRouter (`e2e/fake/server.ts`) already answers embedding calls for memory. Make sure its vectors put a question near the passage it is about.
- **Traces.** Add each new span name to `KNOWN_NAMES`. Extend `tracing.check.ts` to show that no workspace name, document name or passage text gets into a trace.

## Later

- Connectors in a workspace. Add an `mcp_servers` table for the shared definition, as `docs/connectors-plan.md` plans. Each member signs in once to each server, and their connection points to the server.
- Teams, if adding people one by one becomes too slow.
- DOCX, XLSX and HTML documents, as Flow reads them.
- A strict "workspace only" mode, with a "Search the web" button when the workspace has no answer.
- Source chips under an answer that name the document and the passage.
- Asking all of a person's workspaces at once.

## Risks

- **Prompt injection from shared documents.** A member can upload a document that tells the model to call another member's connectors. Workspace text must be marked as data, not instructions. The "Ask first" rule on connector tools that change data must stay. Add a case to `e2e/tests/exfiltration.spec.ts`.
- **Cost.** Inline documents can fill half of the context window on every message. The cache lowers the cost only for providers that cache. Measure this on a real workspace before the documents pull request is merged.
- **Embedding cost.** It is not decided who pays for indexing: the person who uploads, or nobody.
- **A large upload.** Indexing a 10 MB text document is about 12,000 passages, in about 125 embedding calls. The workflow must run it in batches that can start again after a crash.

## Open questions

1. Who pays for embeddings: the uploader's credits, or nobody?
2. Is half of the context window the right inline limit for Ponder, or should it be lower to keep the cost down?
3. Should "Chats" in the sidebar also show workspace chats, with the workspace's name beside each one?
4. Do organisation workspaces need editors in the first release, or are admins enough?
