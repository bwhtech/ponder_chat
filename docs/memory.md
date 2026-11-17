# Memory

Memory is what Ponder knows about a person across chats: what they told it about themselves before. A chat's own history is not memory; the chat holds it.

The design comes from the Seva platform (`~/.t3/projects/seva-studio/platform/docs/memory.md`). Seva ported the contract and the middleware from TanStack AI's memory package, `@tanstack/ai-memory` 1.0.0 (MIT). A backend implements two verbs, `recall` and `save`, so another backend (Mem0, Hindsight, Honcho) can plug in with a new adapter and no other change.

| File | Job |
| --- | --- |
| `server/memory/types.ts` | The contract: `MemoryScope`, `MemoryTurn`, `RecallResult`, `SaveReceipt`, `MemoryAdapter`, `MemoryIndex`. |
| `server/memory/middleware.ts` | `makeMemoryMiddleware()`: recall before the run, save after it. `turnFrom()` builds the turn to save. |
| `server/memory/postgres.ts` | The adapter, the `MemoryStore` service: memories in Postgres, search through the index. |
| `server/memory/save-log.ts` | The decision log (`memory_saves`), and undo. |
| `server/memory/pgvector-index.ts` | The search index, in the same Postgres with pgvector. |
| `server/memory/decision-gate.ts`, `server/memory/gate.json` | The gate: a decision model and its questions. |
| `server/memory/extract.ts`, `server/memory/extract.md` | The two steps together, and the writer and its prompt. |
| `server/memory.ts` | The `Memory` service: the scope, the guidance for the model, the Memory page's calls, and `setup`. |
| `web/MemoryView.vue`, `web/memory.ts` | The Memory page, and the "Remembered" notes under replies. |

## How a reply uses memory

1. **Recall.** The chat workflow's first step, `recallMemoryStep` (`server/workflow/steps.ts`), loads the chat and calls `adapter.recall(scope, query)` with the text of the person's latest message. `MEMORY_GUIDANCE` and the recalled block go after the instructions.
2. **Save.** `saveReply` (`server/workflow/reply.ts`) saves the reply, then calls `Memory.rememberTurn`. That starts `adapter.save(scope, turn)` without waiting, so the run ends and the reply is never held up. Stop saves the reply the same way, so a stopped reply is remembered too. A reply that Stop and the run's last step both save is remembered once.

If recall or save fails, the chat goes on without memory, and the error is logged.

The save runs in the server process, not as a workflow step. A server stop during a save loses that save; the next turn can still save the same thing.

Recall is a workflow step. A reply that was in the middle of its run during the deploy that added memory can fail on its next replay, because its recorded steps do not start with the recall.

## Differences from Seva

- **No organisation memory.** Every memory belongs to one person (`owner` is the user id). Seva also had org-wide memories, keyed by the connected Frappe site. The tables have no `tenant` column. Ponder now has organisation workspaces (`docs/workspaces-plan.md`), but they share instructions and documents, not memories, and a chat in a workspace still remembers only for its writer.
- **Kinds:** `fact` (about the person), `project` (something they work on over weeks), `preference` (how they want answers).
- **What is never kept** is wider: the person's own phone, email, address, ID, bank and card numbers too, health details, and what they say about other people.
- **No `ask_user` answers** in the turn: Ponder has no such tool.
- **pgvector only.** The LanceDB index and the gate benchmark (`scripts/bench-memory-gate.ts`) stay in Seva.
- **Cost counts against credits.** The gate's and the writer's runs go to `runs` as `memory-gate` and `memory-extract`, which `server/credits/Credits.ts` adds up. Embeddings are not recorded.

## The turn

`turnFrom(messages)` builds the turn from the chat as saved:

- `user`: the person's latest message.
- `assistant`: the text of the replies since that message.

Tool results (Python output) and attached files stay out. Memory comes from what the person says, not from a file that could carry instructions.

## What gets remembered: the gate, then the writer

After each turn, `save` decides in two steps what the turn adds. The gate's questions and the writer's prompt are read from file on every call. The build (`npm run build`) copies them into `.output/server/assets/`, so an edit applies after the next build, with no change to the code. The Memory page shows both under "How it decides".

1. **The gate** (`PONDER_MEMORY_GATE_MODEL`, default `perplexity/pplx-decider-v1.2`) is a decision model, called through OpenRouter's Decisions API (`/api/alpha/decisions`). It answers the yes/no questions in `gate.json` with a probability, in about 0.3 seconds, for about $0.000007. `save` above 50% runs the writer; `refuse` above 50% warns the writer that the turn holds something never to keep. Most turns stop here, logged as "Nothing lasting (N% sure)".
2. **The writer** (`PONDER_MEMORY_MODEL`, default `z-ai/glm-5.3-flash`, instructions `extract.md`) runs only on a yes. It gets the gate's verdict and warning, and writes the operations.

The gate gets the saved memories and the turn as `state`, apart from its questions. The writer gets them quoted, and also the memories the person had forgotten (the newest 20), so it does not add them again unless the person asks again.

With 30 or fewer memories, both get all of them. Above that, both get the 15 most related to what the person said, found as recall finds them. The writer returns a one-line `summary` and a list of operations:

| Operation | Fields |
| --- | --- |
| `add` | `kind`, `text`, `quote`, `reason` |
| `update` | `id`, `text`, `quote`, `reason` |
| `forget` | `id`, `reason` |

`quote` is the person's own words that the memory rests on. The adapter checks that it is in what the person said (`quotedIn()` in `extract.ts`: case, spacing, the kind of quote marks and punctuation at the ends do not count; 3 characters at least), and skips the operation if it is not. A skipped operation is logged with the reason.

The output schema is one flat object per operation, not a union: some providers that OpenRouter routes to reject the `oneOf` schema a zod union produces.

The adapter applies the operations in one transaction. An `update` or `forget` that names another person's memory is skipped.

`MEMORY_GUIDANCE` (`server/memory.ts`) tells the model that memory saves itself, and what it never keeps. Keep its list the same as the lists in `gate.json` and `extract.md`, so the model never promises to remember what the writer refuses.

## Nothing is deleted

A forgotten memory, by the writer or on the Memory page, gets `forgotten_at` and stays in `memories`. Recall, the Memory page and the search index leave it out. An update keeps the text it replaced in the log, as `previousText`.

So every save can be undone (`undo(scope, saveId)`), newest change first:

- an added memory is forgotten;
- an updated memory gets its old text back, but only if no one changed it since;
- a forgotten memory comes back.

Only the person whose save it was can undo it, and only once. The undo is logged as a save of its own (`undo_of`), and an undo cannot be undone.

## Recall and search

With 30 or fewer memories, recall gives all of them. Above that it finds the 8 most relevant:

1. **The index** (pgvector): a hybrid query that combines full-text search with vector search over embeddings, merged with reciprocal-rank fusion. Embeddings come from OpenRouter (`PONDER_EMBEDDING_MODEL`, default `google/gemini-embedding-2`), so a query in Hindi finds a memory written in English.
2. **Postgres** full-text search, when the index is off, fails or finds nothing.
3. The most recent memories, when neither finds anything.

The recalled block quotes each memory's text as JSON, so a saved sentence cannot break out of the list and pose as instructions. It tells the model that what the person says now wins over memory.

The index is the `memory_vectors` table. Saves, edits and forgets update it after `memories`; if that fails, the memory is still saved and the log says the index failed. Each row keeps the embedding model that made it. On start, `syncIndex` rebuilds the index when its count differs from `memories`, or when any row is from another model (or from no model: rows from before the column). Until the rebuild ends, search reads only the current model's rows, so it finds fewer memories but never compares vectors of two models.

## On the page

- **Under a reply:** "Remembered: …", "Updated memory: …" or "Forgot: …" for each change that reply led to, with **Undo**. When a reply finishes, the page asks again with `?wait=1`: the server waits for the run to save the reply and for the memory save to end. A click on a note opens the Memory page.
- **Memory page** (sidebar, `?view=memory`), in three tabs: **Memories** (edit and forget), **Decisions** (the latest 30, including the ones that saved nothing, each with **Undo**), and **How it decides** (the gate's questions and the writer's prompt).

## API

| Route | Does |
| --- | --- |
| `GET /api/memory` | The person's memories, their latest 30 decisions, the prompts, and whether memory is on. |
| `PATCH /api/memory/:id` | Changes a memory's text: `{ text }`. |
| `DELETE /api/memory/:id` | Forgets a memory. |
| `POST /api/memory/saves/:id/undo` | Undoes one of the person's saves. |
| `GET /api/threads/:id/memory` | A chat's decisions. `?wait=1` first waits for the reply to be saved (up to 10 seconds) and for its memory save (up to 20). |

## Settings

| Variable | Default | Does |
| --- | --- | --- |
| `PONDER_MEMORY` | on | `off` turns memory off: no recall, no save. |
| `PONDER_MEMORY_INDEX` | pgvector | `off` leaves the index out; search then uses Postgres only. |
| `PONDER_MEMORY_GATE_MODEL` | `perplexity/pplx-decider-v1.2` | The gate's decision model. |
| `PONDER_MEMORY_MODEL` | `z-ai/glm-5.3-flash` | The writer's model. |
| `PONDER_EMBEDDING_MODEL` | `google/gemini-embedding-2` | The embedding model. After a change, the next start rebuilds the memory index and indexes the workspace documents again. |

## Checks

`server/memory.check.ts` runs TanStack's adapter contract against the Postgres adapter, and Ponder's own checks: memories across chats, forget and the log, the quote check, forgotten memories, undo, the related memories that the writer sees, operations on another person's memory, prompt quoting, and the turn. It uses the real Postgres with random owners and deletes them afterwards. A stand-in extractor replaces the model.

```bash
npx tsx server/memory.check.ts                  # no network
npx tsx server/memory.check.ts --index          # also pgvector with real embeddings, including a Hindi query
npx tsx server/memory.check.ts --live           # also the real gate and writer on 10 sample turns, without saving them
```
