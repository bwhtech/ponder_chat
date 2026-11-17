import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ObjectStore from "../../files/ObjectStore.ts";
import { problem } from "../../memory/errors.ts";
import * as AutoRouter from "../../models/AutoRouter.ts";
import { makeEmbedder } from "../../openrouter/embeddings.ts";
import * as Threads from "../../threads/Threads.ts";
import * as Tracing from "../../tracing/Tracing.ts";
import { atLeast } from "../access.ts";
import { excerptsBlock, type WorkspaceTurn } from "../prompt.ts";
import * as Workspaces from "../Workspaces.ts";
import { chooseInline, inlineBudget } from "./budget.ts";
import { passageStore, type Excerpt } from "./passages.ts";
import { documentStore } from "./store.ts";

/**
 * The workspace's part of one chat turn (docs/workspaces-plan.md, "Chat turn"), read by
 * the workspace step (workflow/steps.ts) with the asker's access, as every read is:
 * the instructions, the documents that fit whole, and for the others the best passages
 * for the person's latest message. And workspace_search, for more.
 *
 * Search embeds the question as the app's spend (`workspace-search` in `runs`, for the
 * asker and the chat), and reads only this workspace's ready documents.
 */
export const EXCERPTS = 8;
/** A question longer than this is cut before it is embedded. */
const MAX_QUERY = 4_000;

export type TurnInput = { owner: string; workspaceId: string; threadId: string; modelId: string };
export type SearchInput = { owner: string; workspaceId: string; threadId: string; query: string; documentIds: ReadonlyArray<string> };

/** None when the person can no longer ask in the workspace. Untraced: it runs in the reply's step, under its spans. */
export const workspaceTurn = Effect.fnUntraced(function* ({ owner, workspaceId, threadId, modelId }: TurnInput) {
	const workspace = yield* Workspaces.Workspaces.use((workspaces) => workspaces.instructionsFor(owner, workspaceId));
	if (Option.isNone(workspace)) return Option.none<WorkspaceTurn>();
	const store = documentStore(yield* PgClient.PgClient, yield* ObjectStore.ObjectStore);
	const window = yield* AutoRouter.AutoRouter.use((router) => router.modelWindow(modelId));
	const { inline, search } = chooseInline(yield* store.readySizes(workspaceId), inlineBudget(Option.getOrNull(window)));
	const documents = (yield* store.texts(inline.map((document) => document.id))).map(({ name, text }) => ({ name, text }));
	const searchDocumentIds = search.map((document) => document.id);
	const excerpts = searchDocumentIds.length ? yield* excerptsFor({ owner, workspaceId, threadId, documentIds: searchDocumentIds }) : "";
	return Option.some<WorkspaceTurn>({ ...workspace.value, documents, excerpts, searchDocumentIds });
});

/** The best passages for a question, in a workspace the person can ask in. Empty when they can't. */
export const searchWorkspace = Effect.fn("workspace.search")(function* ({ owner, workspaceId, threadId, query, documentIds }: SearchInput) {
	const access = yield* Workspaces.Workspaces.use((workspaces) => workspaces.accessOf(owner, workspaceId));
	if (!atLeast(access, "ask") || !query.trim()) return [] as Excerpt[];
	const embedder = yield* makeEmbedder;
	const run = { id: `workspace-search:${randomUUID()}`, functionId: "workspace-search" as const, user: owner, threadId };
	const [vector] = yield* embedder.embedMany([query.slice(0, MAX_QUERY)], run);
	const found = yield* passageStore(yield* PgClient.PgClient).search({ workspaceId, documentIds, model: embedder.model, query, vector, limit: EXCERPTS });
	yield* Tracing.annotate({ "ponder.documents": documentIds.length, "ponder.passages": found.length });
	return found;
});

/** The <workspace_excerpts> block for the latest message. A search that fails leaves it out, and the reply goes on. */
const excerptsFor = Effect.fnUntraced(function* (input: Omit<SearchInput, "query">) {
	const query = latestText(yield* Threads.Threads.use((threads) => threads.load(input.threadId)));
	const found = yield* searchWorkspace({ ...input, query }).pipe(
		Effect.catch((error) => Effect.as(Effect.logWarning(`workspace documents: search failed in workspace ${input.workspaceId}:`, problem(error)), [] as Excerpt[])),
	);
	return excerptsBlock(found);
});

function latestText(messages: ReadonlyArray<UIMessage>) {
	const latest = [...messages].reverse().find((message) => message.role === "user");
	return (latest?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
