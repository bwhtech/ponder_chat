import { randomUUID } from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PonderConfig from "../../config.ts";
import * as ObjectStore from "../../files/ObjectStore.ts";
import { makeEmbedder } from "../../openrouter/embeddings.ts";
import * as OpenRouter from "../../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../../openrouter/OpenRouterKey.ts";
import * as Database from "../../runtime/Database.ts";
import * as Http from "../../runtime/Http.ts";
import * as Secrets from "../../secrets/Secrets.ts";
import * as Runs from "../../telemetry/Runs.ts";
import type { DocumentText } from "../documents/document.ts";
import * as Indexer from "../documents/Indexer.ts";
import { passageStore, type Excerpt } from "../documents/passages.ts";
import * as PrepareText from "../documents/prepare-text.ts";
import { PDF_TYPE, storedText } from "../documents/read-document.ts";
import { migrateDocuments } from "../documents/tables.ts";
import { recordedLayer } from "./layers.ts";

/**
 * The search half of the eval (run.ts): indexes the manuals that were read into a schema
 * of its own, with the real Indexer and the real embedding model, then runs each question
 * through the real hybrid search, over all the manuals, as a chat would. The schema is
 * dropped at the end. Needs the database in WORKSPACE_EVAL_DATABASE_URL (or
 * TEST_DATABASE_URL) and the app's OpenRouter key: never DATABASE_URL.
 */
export const TOP = 8;

export type EvalDocument = { file: string; name: string; text: DocumentText };
export type SearchRun = { found: Map<string, Excerpt[]>; documentIds: Map<string, string>; model: string; costUsd: number; passages: number };

export async function searchAll(databaseUrl: string, documents: EvalDocument[], questions: ReadonlyArray<{ id: string; question: string }>): Promise<SearchRun> {
	const schema = `eval_${randomUUID().slice(0, 8)}`;
	const runtime = ManagedRuntime.make(layerFor(databaseUrl, schema));
	try {
		return await runtime.runPromise(
			Effect.gen(function* () {
				yield* setup(schema);
				const documentIds = new Map<string, string>();
				for (const document of documents) documentIds.set(document.file, yield* index(document));
				const embedder = yield* makeEmbedder;
				const passages = passageStore(yield* PgClient.PgClient);
				const found = new Map<string, Excerpt[]>();
				for (const question of questions) {
					const [vector] = yield* embedder.embedMany([question.question], { id: `workspace-search:eval-${question.id}`, functionId: "workspace-search", user: "eval", threadId: null });
					found.set(question.id, yield* passages.search({ workspaceId: "eval", documentIds: [...documentIds.values()], model: embedder.model, query: question.question, vector, limit: TOP }));
				}
				const [spend] = yield* PgClient.PgClient.use((sql) => sql<{ cost: number; passages: number }>`
					select (select coalesce(sum(cost_usd), 0)::float8 from runs) as cost, (select count(*)::int from workspace_passages) as passages`);
				return { found, documentIds, model: embedder.model, costUsd: spend.cost, passages: spend.passages };
			}),
		);
	} finally {
		await runtime.runPromise(PgClient.PgClient.use((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`))).catch(() => undefined);
		await runtime.dispose();
	}
}

/** The tables the Indexer needs, in the eval's schema: a stand-in for `workspaces`, `runs`, the secrets the key is read from, and the documents'. */
const setup = (schema: string) =>
	PgClient.PgClient.use((sql) =>
		Effect.gen(function* () {
			yield* sql.unsafe(`create schema ${schema}`);
			yield* sql`create table workspaces (id text primary key)`;
			yield* sql`insert into workspaces (id) values ('eval')`;
			yield* Secrets.Secrets.use((secrets) => secrets.migrate);
			yield* Runs.Runs.use((runs) => runs.migrate);
			yield* migrateDocuments(sql);
		}),
	);

/** A manual whose text was read already: the Indexer splits and embeds it, as after an upload. */
const index = (document: EvalDocument) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		const id = randomUUID();
		yield* sql`
			insert into workspace_documents (id, workspace_id, name, media_type, size, text, added_by)
			values (${id}, 'eval', ${document.name}, ${PDF_TYPE}, 0, ${storedText(document.text.pages)}, 'eval')`;
		const outcome = yield* Indexer.Indexer.use((indexer) => indexer.run({ documentId: id, generation: 1 }));
		if (outcome !== "ready") {
			const [row] = yield* sql<{ error: string | null }>`select error from workspace_documents where id = ${id}`;
			return yield* Effect.die(new Error(`${document.file} was not indexed: ${row?.error ?? outcome}`));
		}
		return id;
	});

function layerFor(databaseUrl: string, schema: string) {
	const url = `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`;
	const env = Object.fromEntries(
		["OPENROUTER_API_KEY", "PONDER_EMBEDDING_MODEL", "OPENROUTER_BASE_URL"].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
	);
	return Indexer.layer.pipe(
		Layer.provideMerge(Layer.mergeAll(OpenRouterKey.layer, Runs.layer, ObjectStore.layer, PrepareText.layer, recordedLayer(new Map()))),
		Layer.provideMerge(Layer.mergeAll(OpenRouter.layer, Secrets.layer)),
		Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
		Layer.provideMerge(PonderConfig.layerFromEnv({ ...env, DATABASE_URL: url })),
	);
}
