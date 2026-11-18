# Ponder Chat: workspaces

Goal: a person collects instructions and documents in a workspace, then asks questions that are answered from them. A workspace is for one person, for people they choose, or for the whole organisation.

The design comes from the prototype at https://sketch.netchamp.dev/u/nagariahussain/ponder-workspaces (version 6). This file keeps the decisions, the plan for each pull request, and the risks.

## Status

Built. The three parts below ("Pull requests") are all in one pull request, #66.

Part 1, workspaces and sharing: the tables, `accessOf`, the API, people search, `threads.workspace_id`, the instructions in the prompt (`server/workspaces/`), `Shell.vue`, the sidebar, the workspace page, the dialogs and the composer chip (`web/workspaces/`).

Part 2, documents (`server/workspaces/documents/`): upload, the indexing workflow, the indexing log, Details and "Try again", inline documents or excerpts and `workspace_search` on each turn, the system function ids in `charged_runs`, and memory embeddings in `runs`. A sweep starts indexing again for a document that stays in Indexing with no run. On the test questions, the top-8 hit rate is 30 of 31 (97%).

Part 3, the admin part, is built: `/admin/workspaces` (`server/workspaces/admin.ts`, `web/admin/pages/Workspaces.vue`) lists organisation workspaces with their documents, statuses, errors, indexing cost and each document's log, and private workspaces as totals with no names: how many, documents by status, indexing cost, and the errors of failed documents with names cut out. The Activity page names the four workspace events and shows the length of the instructions, not their text. The overview has a "System" line: the cost of each system function id over the same days, from `runs`.

Embedding model: `qwen/qwen3-embedding-8b`, from 18 November 2026. Through OpenRouter with Zero Data Retention, the earlier default `google/gemini-embedding-2` takes only one text for each call, so a 10 MB text was about 12,000 calls. Qwen takes batches. On the test questions it scores the same as `google/gemini-embedding-2`, `google/gemini-embedding-001` and `openai/text-embedding-3-large` (30 of 31, the same answers first), and it costs $0.0026 for both manuals, against $0.049. The embedder still falls back to one text for each call for a model that refuses batches. A change of `PONDER_EMBEDDING_MODEL` embeds the memory index again and indexes the workspace documents again at the next start, also a document that was in the middle of indexing; searches in between find only what the new model has indexed.

## Words

| Word | Meaning |
| --- | --- |
| Workspace | A name, instructions and documents. A chat can belong to one workspace. (A description column exists, but the app does not ask for it or show it for now.) |
| Organisation workspace | A workspace that everyone can use. Only an admin makes one. |
| Private workspace | A workspace that only its owner and the people they add can use. Anyone makes one. |
| Owner | The person who made the workspace. |
| Member | A person the owner added. Each member can ask, or can ask and edit. |
| Document | A file in a workspace. Its text is kept in the database. |
| Passage | A part of a document's text, about 1,000 characters, with its embedding. The unit that search returns. |

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| Teams | None. The owner adds people one by one. | An internal tool with tens of people does not need teams yet. Teams can come later without changing this model. |
| Who makes what | An admin makes organisation workspaces. Anyone makes private workspaces. | Org-wide content needs one person who is responsible for it. |
| Who edits an organisation workspace | Admins only. Everyone else can ask. | Enough for the first release. Editors who are not admins are in "Later". |
| Finding people | `GET /api/people?q=` searches every account by name or email, for any signed-in person. | Everyone in the organisation can see everyone. The prototype's people picker needs it. |
| Chats | A chat stays private to the person who wrote it, also in a shared workspace. Members share instructions and documents, never chats. | The privacy rule that admins see usage only must also hold for workspace owners. |
| Admins | An admin edits organisation workspaces. An admin cannot open a private workspace unless its owner adds them. | Same reason. The admin page shows counts of private workspaces only. |
| One workspace for each chat | The first message sets it. It never changes. | The instructions are in the cached system prompt. A change would make the answers before it hard to explain. |
| Lost access | The server checks access on each message. A person who was removed can still read the chat, but cannot send in it. | Access is the owner's decision, and it must take effect at once. |
| Deleting a workspace | Its documents and passages are deleted. Its chats stay, and are no longer in a workspace. | A member's chats belong to the member, not to the owner. |
| URL | `/?w=<slug>`, the same way `?t=<id>` opens a chat. The slug comes from the name when the workspace is made (lowercase ASCII words with hyphens, such as `hr-policies`). A slug that is taken gets a random suffix of 4 characters (`hr-policies-k3x9`). A rename keeps the slug, and the slug of a deleted workspace is never given again. A link with the id (`?w=<id>`) still opens, and the page puts the slug in its place. `GET /api/workspaces/:id` takes the slug or the id; the other routes take the id. | The chat page has no router, and the server serves it only at `/`. A slug that never changes keeps every link that people saved. A random suffix does not tell how many others chose the same name. |
| Code name | `web/Workspace.vue` (the signed-in layout) becomes `web/Shell.vue`. | The word "workspace" must have one meaning in the code. |
| Connectors | Later. In a workspace chat, the model uses the person's own connectors, as it does now. | A connector's credentials are in the owner's row. A shared connector with one sign-in for each member needs a new table (see "Later"). |
| Search store | Postgres: pgvector for meaning, `to_tsvector('simple', …)` for keywords, merged with reciprocal rank fusion. Not SQLite, as Flow uses. | Ponder already runs Postgres with pgvector for memory (`server/memory/pgvector-index.ts`). One database keeps backups, access checks and deletes in one place. |
| Who pays to index | The system, not the uploader. Embeddings, picture pages read by a model, and the embedding of each search cost no credits. Each call is kept in `runs`, as titles are, and admins see the total as system spend. | The documents are a shared resource for many people. The uploader must not pay for the others. The spend must still be visible. |
| Inline limit | Half of the model's context window, as in Flow. | Cost is not the main concern. Answers are better when the whole document is in the prompt. |
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

Flow is the starting point, not a rule. Where a better way is found and the test questions (below) show that it is better, Ponder uses it. "Where Ponder does better than Flow" lists the changes so far.

Ponder uses the same steps, with Postgres in place of MariaDB and SQLite. Memory already does hybrid search this way (`server/memory/pgvector-index.ts`): pgvector, `to_tsvector('simple', …)` and reciprocal rank fusion. Embeddings use `PONDER_EMBEDDING_MODEL` through OpenRouter.

1. **Upload.** `POST /api/workspaces/:id/documents` takes the same file types and the same 10 MB limit as a chat attachment: PDF, text, Markdown, CSV, TSV and JSON. The bytes go to the object store under `workspaces/<id>/<document>`. DOCX and spreadsheets are in "Later".
2. **Extract.** The text is read once and kept in `workspace_documents.text`. A PDF is read as "PDF reading" below tells. A CSV or TSV becomes a Markdown table, with each row padded to the widest one. Its size is worked out before it is built: a table of more than 500 columns, or of more than 20 million characters once padded, fails with a reason that the person can act on ("This table is too wide…"). JSON is pretty-printed only when its indents keep it under the same size; else it stays as written. Markdown and plain text never grow.
   Reading a document and splitting its text into passages run in a worker thread (`prepare-text.ts`), never on the server's own thread, as pdf.js does for a chat's PDFs. The size limits come first, but they can't foresee every input, and the server must keep answering chats meanwhile. A text document is read and split in one job. A PDF is read in one job (LiteParse, or pdf.js when LiteParse does not load, and the repeated header and footer lines dropped: `parse-pdf.ts`); a model then reads its picture pages on the server's thread, one small page at a time; and its stored text and passages are made in a last job. Two jobs run at once, and the others wait. A job that takes more than 30 seconds (2 minutes to read a PDF, as LiteParse's own limit was) or 512 MB is stopped, and the document fails for good with that reason: "Try again" starts it again. The worst text that the limits let through, a 10 MB CSV of short numbers, takes about 2.5 seconds and 380 MB.
   The server's thread copies a worker's answer whole before it can look at it, so the worker checks its answer against the limits of `limits.ts` first, and a document past them fails with "The document is too large to read: …". LiteParse's own answer, each piece of text with its position, is 27 times the Markdown (16 MB for the 398-page manual): the worker takes it in, and gives the server only the Markdown.

   | Limit | Value | Why |
   | --- | --- | --- |
   | Pages of a PDF | 2,000 | Five times the 398-page manual. LiteParse stops there. |
   | Text kept | 20 million characters | As large as a table may be. A 10 MB CSV of short numbers is 16.7 million. |
   | Passages | 25,000 | A 10 MB CSV of short numbers makes 17,430, and one of 20 short columns 21,067: about 260 embedding calls. |
   | One passage | 12,000 characters | The chunker keeps each under it: a row of 8,000 with a header of 2,000. |
   | All passages, with their location lines | 40 million characters | Twice the text: a header is repeated in each part of its table. The 20-column CSV makes 19.4 million. |

   A table header of more than 2,000 characters is not repeated: it is text of its own, and its rows follow as lines. Repeated, a header of 50,000 characters over 2,000 short rows made 100 million characters of passages from a file of 54 KB. Received whole on the server's thread, the largest answer within the limits held it up for about 20 ms.
   A document waits for its turn before its bytes or text are loaded, and keeps it until its passages are saved (`Indexer.ts`): one permit for each MB of its file, at least one, of 40 in all. So the Workflow queue's runs that wait hold only their ids, and the documents in preparation hold at most about 40 MB of files with their text and passages. A PDF keeps its permits while a model reads its picture pages, as each page is copied from its bytes. A run that waited checks again that it is still the document's latest before it loads anything.
3. **Index.** A workflow run splits the text into passages (about 1,000 characters, split by structure: see below), embeds them in batches of 96, and saves them in one transaction. Each write of a step (the text, the passages, a batch's vectors, Ready or Failed) runs in a transaction that locks the document's row (`for no key update`) and checks that the run's generation is still the latest and the document is still Reading. Else the step does nothing: a model call can take minutes, and a newer run, "Try again" or a delete may come meanwhile. The `runs` rows of its model calls are kept all the same. The document shows "Indexing…" until the run ends, then "Ready" or "Failed". The document keeps its run's id. When it stays "Indexing…" for 5 minutes with no live run (a crash before the run started, or a run that ended without settling it), the sweep starts a new run, and "Try again" also accepts it.
4. **Choose inline or search, on each turn.** Use Flow's attachment rule. When the text of all ready documents fits in half of the model's context window, all of it goes into the system prompt as `<document name="…">` blocks. Otherwise, the largest documents move to search until the rest fit. The existing limit of 300,000 characters for files in one call also applies.
5. **Search.** For documents in search, the 8 best passages for the person's message go into the latest message as a `<workspace_excerpts>` block, the way memory adds `<memory>`. The model also gets a `workspace_search(query)` tool for more searches. The server binds the tool to the chat's workspace, so the model cannot search another one.
6. **Deadlines.** Each embedding call (the AI SDK's own tries included) has a timeout: 30 seconds for a memory or a search, 2 minutes for a batch of 96 passages. Then the request is aborted, and the call fails with `EmbeddingTimedOut`. The indexing step is tried again, as for `EmbeddingFailed`. A page that a model reads has its own timeout of 3 minutes for each try.
7. **Model change.** Each passage stores the embedding model that made it. Search reads only passages from the current model. When the model changes, a check at startup indexes the old documents again.

Instructions and inline documents stay the same during a chat, so the provider's prompt cache keeps them. Excerpts change on each message, so they go in the latest message, outside the cache.

### Where Ponder does better than Flow

1. **Split by structure, not by character count.** Flow cuts every 1,000 characters, with 200 characters of overlap. The dose table in the nephrology manual is 2,500 characters, and the FIGO regimens are 3,800 characters. A cut every 1,000 characters puts a dose such as "LD 500 mg/L" in a passage without its drug name or its column heading. Ponder splits LiteParse's Markdown:
   - At headings first, then at paragraphs. Never inside a table row.
   - A table that is too long for one passage is split by rows, and each part repeats the table's header row.
   - A passage can be longer than 1,000 characters to keep a row or a short table whole. The limit is 2,000.
2. **Each passage knows where it is.** Before embedding, each passage gets a first line with the document name, the headings above it, and the page: `Nephrology manual › Peritonitis › Table 5 (page 251)`. The line is also kept with the passage, so excerpts and answers can name the page.
3. **Test questions decide.** `server/workspaces/eval/` has about 30 questions on the two procedure manuals, each with the page that answers it. Some questions are answered only by a table or a picture page. The manuals are not in the repo: the script reads them from a folder in `WORKSPACE_EVAL_DIR`. It indexes them and reports how many answers are in the top 8 passages. Run it before and after each change to chunking, search or the PDF reader, and put the numbers in the pull request.

To try next, each only if the test questions show a gain:
- A reranking model on the top 30 passages.
- More or fewer than 8 excerpts.
- Different weights for keyword and vector results in the fusion.

### PDF reading

The pdf.js reader in `server/pdf-text.ts` reads only the text layer. It gets nothing from a scanned page, and nothing from a table or a chart that is a picture. In the two real procedure manuals we tested, the antibiotic dose tables and the FIGO misoprostol regimens are pictures.

1. **LiteParse reads every page** (`@llamaindex/liteparse`, MIT). It runs in the Node server, in a worker thread with a child process of its own, with no API key and no cost. It writes Markdown, with Markdown tables, and gives signals for each page. OCR stays off.
2. **A model reads some pages.** A page goes to a model when one picture covers 10% of the page or more (`largestImageCoverage >= 0.1`), or when the page is one scanned picture (`fullPageImage`). Do not use LiteParse's own `needsOcr` flag: it is true for every page that has a logo.
3. **The model is `google/gemini-3.8-flash`** through OpenRouter, with `provider: { zdr: true }`, `reasoning: { effort: "low" }`, and one page per call as a one-page PDF. Its text takes the place of LiteParse's text for that page. The prompt asks for Markdown tables, plain text with no LaTeX, no page header or footer, and chart values under "Values read from the chart (approximate):".
4. **No text and no model.** When a page has no text layer and the model call fails, the document is "Failed" with the page number. It is not "Ready" with pages missing.
5. **Each paid page is kept as soon as it is read.** Its `runs` rows, then its text and record in `workspace_page_reads`, by document, generation and page. A run of the same generation that starts again (a crash, a step that Workflow tries again) uses those pages and pays only for the others. The rows go once the run saved its text or failed. "Try again" is a new generation, and reads every page again. Before each batch of 8 pages the read checks that its run is still the latest and the document is still Reading; else it stops, so a deleted document pays for no more pages. A page that a crash cut off between its answer and its save is read again, and its second cost is hidden under the same run id: that window is short, and is accepted.

**What we measured** (17 November 2026):

| | Nephrology manual | Obstetrics manual |
| --- | --- | --- |
| Pages | 398 | 180 |
| LiteParse time, 2 CPUs | 3.2 s | 3.5 s |
| Pages sent to the model | 21 | 3 |
| Model cost | $0.044 | $0.011 |

- Gemini read the 31-row dose table, all its doses and its footnotes, the same as the page. Two runs gave the same 119 numbers. The regimen chart doses were also correct.
- Chart values were within about 1,000 of the bars. They are estimates, so the label says "approximate".
- LiteParse kept the body text. In a sample of 600 lines, all were there. The only differences were format, such as `4<sup>th</sup>`.
- On 13 synthetic hard pages (scans, phone photos, a fax, handwriting, Kannada and Hindi), Gemini 3.8 Flash had 0.6% character error. It was the only model that read all the Kannada place names. Smaller models put in names of other real towns.
- Rejected: LiteParse's own Tesseract OCR (40% error on scans), OpenRouter's `mistral-ocr` parser (wrote Kannada in Sinhala script, and has no ZDR), the `cloudflare-ai` parser (no OCR), and DeepSeek V4.1 Flash (gave no text on 9 of 24 real pages, because its reasoning used all the output tokens).
- A page costs about $0.0015 to $0.0023, so a scanned book of 400 pages costs about $0.60 to $0.95. OpenRouter's batch price is about half, for documents that nobody waits for.

The test scripts are not in the repo. Add a small test with one picture page to the documents pull request.

### System spend

Some model calls are made by the app, not for one person's reply. They cost no credits, but each one is kept in `runs`, so that admins can see and audit the spend.

1. **Titles do this now.** `thread-title` calls are in `runs`, and `charged_runs` leaves them out (`server/telemetry/Runs.ts`). But no admin page shows their cost. Only the daily total in `deploy/sentinel.sh` counts them.
2. **Memory embeddings are not in `runs` at all.** `server/memory/pgvector-index.ts` calls `embedMany` and `embed`, and does not keep the usage. Fix this in the documents pull request, because the same embedding code is used.
3. **A list of system function ids** takes the place of the single `TITLE_FUNCTION_ID` rule in the `charged_runs` view:

   | `function_id` | Call |
   | --- | --- |
   | `thread-title` | Name a chat (now) |
   | `memory-embed` | Embed memories and memory searches |
   | `workspace-index` | Embed a document's passages |
   | `workspace-pdf` | Read a picture page with a model |
   | `workspace-search` | Embed the question for a workspace search |

4. **Each row names who caused it.** `user` is the uploader for indexing and the asker for a search, so an admin can see who causes the spend. `thread_id` is set for a search. Indexing rows get the document id in their run id (`workspace-index:<document>:<batch>`), so a document's cost can be added up, also after the document is deleted.
5. **Admin usage page.** Add a "System" line: the cost for each system function id, for the same days as the rest of the page. It does not count against anyone's credits.

### Indexing log

Each document keeps a log of what was done to it, so a person can see why a document failed or which pages a model read, and an admin can see what indexing costs.

1. **One row for each step** in `workspace_document_log`. Only the indexing workflow writes rows. Nothing updates or deletes a row, except when the document is deleted.

   | Step | What the row keeps |
   | --- | --- |
   | `uploaded` | Size, media type, who uploaded it |
   | `parsed` | Engine (`liteparse` or `pdf-text`), page count, characters, time |
   | `page-read` | Page number, why it was sent (`picture` or `scan`), model, time, cost, OK or failed and the error |
   | `chunked` | Number of passages |
   | `embedded` | One row for each batch: passages, model, time, cost |
   | `ready` or `failed` | Total time, total cost, and for `failed` the step and the error. A worker job that failed adds its reason (`timeout`, `memory`, `failed` or `stopped`) |
   | `reindexed` | Why: the embedding model changed, or a person asked |

2. **No document text in the log.** A row keeps numbers, page numbers, model names and error messages, never the text of a page or a passage. The error of a model call is cut to 300 characters, as OpenRouter errors are now.
3. **The cost in the log comes from `runs`.** Each `page-read` and `embedded` row keeps its `runs` id. The cost shown is read from `runs`, so the two never disagree. This includes a cost that the sweep fills in later. Each try that may be billed has a `runs` row of its own: the calls that worked in a batch that failed (`<id>:failed:<uuid>`), and each try of a page that OpenRouter answered (`<id>:try:<n>`, with its own generation id, so the sweep fills in its cost too). A row's cost adds its tries. The `ready` or `failed` row shows every call of its generation. A document's total, also on the admin page, adds every `runs` row whose id names the document (an expression index on `split_part(id, ':', 2)`), so a batch whose tries all failed still counts.
4. **Who sees the log.**
   - People who can edit the workspace: a "Details" view on each document in the side panel. It shows plain steps ("Uploaded · PDF, 3 pages", "Read page 2 from a picture", "Ready"). No model names, times or costs. A failure has one wording: the row's status says "2.3 MB · Could not read page 3", with a "Try again" button, and the failed step in Details has the same title. A cause shows under it only when it has plain words ("It took too long."). The admin's log keeps the raw error.
   - People who can only ask: the status while it is not Ready (Reading, Failed).
   - Admins on `/admin/workspaces`: for organisation workspaces, the full log. For private workspaces, the counts, cost and errors, with no workspace or document names, as for the rest of private workspaces.
5. **Server logs and traces.** One log line when indexing starts, ends or fails, with the document id and workspace id only. One trace for each indexing run (`workspace.index`), with a child span for each step (`workspace.parse`, `workspace.page-read`, `workspace.embed`). Add these names to `KNOWN_NAMES` in `server/tracing/privacy.ts`. `tracing.check.ts` must show that no document name or text gets into these spans.

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
workspace_document_log (
	id, document_id → workspace_documents on delete cascade, workspace_id,
	step, detail jsonb, run_id → runs (null when no model call), created_at
)
workspace_passages (
	id, document_id → workspace_documents on delete cascade, workspace_id,
	ordinal, location, page, content, embedding vector, model
)
workspace_object_deletions (
	object_key primary key, added_at   -- the bucket keys of deleted documents, until their objects are gone
)
threads.workspace_id               -- null for a chat outside a workspace
```

Deleting a document or a workspace deletes the rows and writes their bucket keys to `workspace_object_deletions` in one transaction. The objects are deleted only after it commits, and each key is removed once its object is gone. A key that is still there after a minute (a crash, a bucket that failed) is deleted by the sweep. So a rollback never leaves a document whose file is gone, and no bucket call holds a transaction open.

The tables are made in a `migrate` effect in a new `Workspaces` service, added to `migrateAll` after `Auth` and `Threads` (`server/startup.ts`).

Access is in one function, `Workspaces.accessOf(userId, workspaceId)`. It returns `none`, `ask`, `edit` or `owner`:

| Workspace | Owner | Member | Admin | Anyone else |
| --- | --- | --- | --- | --- |
| Organisation | `owner` | — | `edit` | `ask` |
| Private | `owner` | `ask` or `edit` | `none`, unless added | `none` |

Adding to a workspace and deleting it take turns on the workspace's row. A new chat's first message and an upload lock it (`for key share`), check again that it is live and that the person may use it, and insert the chat or the document in the same short transaction (`Workspaces.admit`). A delete locks it first (`for update`), so it waits for those, and they wait for it and then find it deleted. The bucket upload and the start of the indexing run are outside that transaction; an upload that is refused there deletes its object.

Only the owner changes the members of a private workspace. Only an admin changes an organisation workspace, or changes a workspace's kind. Every read and write of a workspace, a document or a passage goes through `accessOf`.

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
| `GET /api/workspaces/:id/documents/:doc/file` | `ask` and above: the uploaded file, which opens in the chat's side panel from the document's name |
| `GET /api/people?q=` | Any signed-in person. At most 20 results, with id, name and email. |
| `POST /api/chat` | The body gets `workspaceId`, read only on the first message. |
| `GET /api/admin/workspaces` | Admins: organisation workspaces, and counts of private ones |

A workspace that the person cannot use answers 404, never 403, so a request does not show that the workspace exists. Changes to organisation workspaces go to the audit log (`admin_events`).

## Chat turn

1. `startRun` (`server/workflow/replies.ts`) reads the chat's workspace, checks `accessOf`, and puts `workspaceId` in `ChatTurn`.
2. A new step, `workspaceContextStep`, returns the instructions, the inline documents and the excerpts. It is a step because workflow code cannot read the database.
3. `chat.ts` adds the instructions, the inline documents and a fixed `WORKSPACE_GUIDANCE` text to the system prompt. The guidance says: answer from the workspace first, name the document you used, and say so when the workspace does not have the answer.
4. `thread-messages.ts` adds `<workspace_excerpts>` to the latest message. The excerpts have a budget of 5 seconds, the embedding of the question and the search together, because the reply's model call waits for them. When the budget runs out, the search is interrupted (which aborts the embedding request), and the reply goes on without excerpts.
5. The `workspace_search` tool is added only when the workspace has documents in search.

## Web

- **Layout.** Rename `Workspace.vue` to `Shell.vue`. Add a "Workspaces" section above "Chats" in `ChatsPanel.vue`, and the same rows in `SidebarPlaceholder.vue`, so nothing moves when the panel loads.
- **Sidebar rows.** Organisation workspaces first, then workspaces that others shared, then the person's own. Each row has an icon for its kind: a building, people, or a lock.
- **Chats list.** "Chats" shows all of the person's chats, also the ones in a workspace, in the same date groups. A row shows only the chat's title, so titles are not cut short. The chat itself shows its workspace: a breadcrumb in its header ("Dialysis unit / Exit-site care") links back to the workspace page, and the composer's placeholder names it ("Ask in Dialysis unit"). The workspace page also lists its own chats, from `GET /api/threads?workspace=<id>`: the person's chats in that workspace, chosen before the list's limit of 200, so newer chats elsewhere never hide a workspace's older ones. The page adds the chats of the person's list in that workspace (a chat just started, a new title), and asks again whenever that list changes.
- **Workspace page (`?w=<slug>`).** A header with the name, Share (for the owner, and for admins on organisation workspaces) and a menu with Delete. People who can edit rename the workspace by its title, in place: a click or Enter makes it a field of the same size, Enter or leaving the field saves the name only, Escape cancels, and an empty name is not taken. Then the composer, "Your chats", and a side panel with instructions, documents and "People" (once someone other than the owner can use it). Share in the header is the one place to change who can use it. Files dropped anywhere on the side panel are uploaded. "Add" (empty) or "Edit" (filled) on the Instructions heading row opens a dialog with only the instructions, and saves only them. On a phone, the side panel goes under the chats.
- **Composer.** A new chat picks a workspace with a menu in `PromptInputTools`, beside the model selector. Once a chat has a workspace, the menu goes, and the placeholder names the workspace.
- **Dialogs.** New workspace (name, instructions, and who can use it for an admin), Instructions and Share, each loaded on first use with a `DialogFrame` placeholder, as Settings is. The people picker is frappe-ui's `Combobox` with `filterable: false`. It calls `/api/people` and shows the name with the email under it.
- **Admin.** A "Workspaces" page at `/admin/workspaces`. Add it in three places: `router.ts`, the navigation in `App.vue`, and the boot navigation in `admin.html`.
- **Rules.** Follow the ponder-ui skill: loading, empty and error states for each list, no layout shift on load, screenshots at 1440×900 and 390×844 in light and dark.

## Pull requests

1. **Workspaces and sharing.** The tables without documents, `accessOf`, the API, people search, `threads.workspace_id`, instructions in the prompt, the rename to `Shell.vue`, the sidebar, the workspace page, the dialogs and the composer chip. A person can make a workspace with instructions, share it, and chat in it.
2. **Documents.** Upload, text extraction, the indexing workflow, inline or search on each turn, `workspace_search`, and the Reading, Ready and Failed states. The system function ids in `charged_runs`, and memory embeddings kept in `runs`. The indexing log, the Details view and "Try again".
3. **Admin page.** `/admin/workspaces` with the indexing log, audit events for organisation workspaces, and the "System" line on the usage page.

Each pull request ships alone, and each one updates the README. The first one also changes the "no organisation" lines in `docs/pilot-plan.md` and `docs/memory.md`.

## Tests

- **Unit tests** (`*.test.ts`, with `TEST_DATABASE_URL`):
  - Every cell of the access table.
  - Sharing changes, and a member who loses access.
  - People search.
  - The chunker: no table row is split, a split table repeats its header row, and each passage has its location line.
  - The order of hybrid search results.
  - The inline or search choice at the edge of the budget.
- **End-to-end** (`e2e/tests/workspaces.spec.ts`):
  1. Person A makes a private workspace and shares it with B.
  2. B sees it in the sidebar and asks a question that uses its instructions.
  3. C gets "not found" for the same URL.
  4. A cannot read B's chat in the workspace.
  5. A removes B, and B can no longer send in that chat.
  6. An admin makes an organisation workspace, and every person sees it.
  7. A document goes from Reading to Ready, and an answer uses one of its passages.
  8. An editor opens the document's Details and sees its steps. A person who can only ask does not see them.
  9. A document that fails shows its error, and "Try again" makes it Ready.
- **Embeddings in end-to-end tests.** The fake OpenRouter (`e2e/fake/server.ts`) already answers embedding calls for memory. Make sure its vectors put a question near the passage it is about.
- **Traces.** Add each new span name to `KNOWN_NAMES`. Extend `tracing.check.ts` to show that no workspace name, document name or passage text gets into a trace.
- **Indexing log.** A unit test runs the workflow on a PDF with one picture page and a fake model. It checks the rows in order, that each cost matches its `runs` row, and that no row holds page text.

## Later

- Connectors in a workspace. Add an `mcp_servers` table for the shared definition, as `docs/connectors-plan.md` plans. Each member signs in once to each server, and their connection points to the server.
- Teams, if adding people one by one becomes too slow.
- Editors for organisation workspaces who are not admins.
- DOCX, XLSX and HTML documents, as Flow reads them.
- A strict "workspace only" mode, with a "Search the web" button when the workspace has no answer.
- Source chips under an answer that name the document and the passage.
- Asking all of a person's workspaces at once.

## Risks

- **Prompt injection from shared documents.** A member can upload a document that tells the model to call another member's connectors. Workspace text must be marked as data, not instructions. The "Ask first" rule on connector tools that change data must stay. Add a case to `e2e/tests/exfiltration.spec.ts`.
- **Cost.** Inline documents can fill half of the context window on every message. That is part of the reply, so it costs the asker's credits. This is accepted. The cache lowers the cost only for providers that cache. Measure the cost of one message on a real workspace before the documents pull request is merged, to make sure the daily credits are still enough.
- **LiteParse is a native package.** It has a Rust core. The core comes as an optional package for each platform (`@llamaindex/liteparse-linux-x64-gnu`), with no install script, and `nitro.config.ts` copies it into `.output`. npm 11 (here and on the VM) skips install scripts that are not allowed. The four packages it skips (esbuild, @swc/core, cbor-extract and vue-demi) were already in `main`, and Ponder already runs without their scripts. Checked on 18 November 2026 with a clean `npm ci` as `deploy/release.sh` runs it: the build passes, LiteParse loads from `.output` and reads the test PDF, and the unit tests pass. When the package does not load, the server still starts, and PDFs are read with pdf.js (`pdfjs-text.ts`) in the same worker.
- **A large upload.** Indexing a 10 MB text document is about 12,000 passages, in about 125 embedding calls. The workflow must run it in batches that can start again after a crash.
- **Cancelling an indexing run does not stop its step.** Workflow DevKit (5.4) gives a step no signal when its run is cancelled: it only starts no new step of that run. Ponder never cancels an indexing run: "Try again", a new model and a delete start a new generation, and the old run's steps do nothing (step 3 above). A run cancelled by hand from Workflow's own tools runs its step on: a worker job until it ends or its deadline (30 seconds, 2 minutes for a PDF), and a PDF's page reads until the next batch of 8 pages, which checks first that the run is still the document's latest. A step that waits for its turn checks again once it has it.
