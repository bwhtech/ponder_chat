/**
 * The lifecycle of workspace documents when things happen at once or stop half-way: a
 * workspace deleted while its bucket fails, an indexing step that a newer run overtakes,
 * and a first chat or an upload that races a delete. On a real Postgres
 * (TEST_DATABASE_URL), in a schema of its own, with a stand-in bucket and OpenRouter.
 */
import { readFileSync } from "node:fs";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { base, blockedBy, holdRows, USERS_TABLE, useTestSchema } from "../test-env.ts";
import { startFakeOpenRouter } from "./fake-openrouter.ts";
import type { Documents as DocumentsTag } from "./Documents.ts";
import type { IndexRequest, Indexer as IndexerTag } from "./Indexer.ts";
import type { Workspaces as WorkspacesTag } from "../Workspaces.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_lifecycle_${tag}`;
useTestSchema(schema);
const openRouter = await startFakeOpenRouter();
process.env.OPENROUTER_BASE_URL = openRouter.url;

const { runPromise, dispose } = await import("../../runtime/runtime.ts");
const ObjectStore = await import("../../files/ObjectStore.ts");
const Threads = await import("../../threads/Threads.ts");
const AdminEvents = await import("../../admin/AdminEvents.ts");
const Runs = await import("../../telemetry/Runs.ts");
const Workspaces = await import("../Workspaces.ts");
const Documents = await import("./Documents.ts");
const Indexer = await import("./Indexer.ts");
const IndexRuns = await import("./IndexRuns.ts");

const who = { ana: `ana-${tag}` } as const;
const ana = { id: who.ana, email: "ana@example.invalid" };

/** The bucket: objects by key. `crashOnRemove` stops the process (a defect) after the object is gone. */
const bucket = { objects: new Map<string, Uint8Array>(), crashOnRemove: false };
const fakeObjects = Layer.succeed(
	ObjectStore.ObjectStore,
	ObjectStore.ObjectStore.of({
		enabled: true,
		put: (key, data) => Effect.sync(() => void bucket.objects.set(key, data)),
		get: (key) => Effect.sync(() => Option.fromUndefinedOr(bucket.objects.get(key)).pipe(Option.map((data) => Buffer.from(data)))),
		remove: (key) =>
			Effect.suspend(() => {
				bucket.objects.delete(key);
				return bucket.crashOnRemove ? Effect.die(new Error("the process stopped")) : Effect.void;
			}),
	}),
);

/** Workflow's place: the runs asked for. */
const asked: IndexRequest[] = [];
const fakeRuns = Layer.succeed(
	IndexRuns.IndexRuns,
	IndexRuns.IndexRuns.of({ start: (request) => Effect.sync(() => (asked.push(request), `run-${request.documentId}-${request.generation}`)), status: () => Effect.succeed("live") }),
);

/** The workspace services on the stand-in bucket; the rest is the app's. */
const services = Layer.fresh(Documents.layer).pipe(
	Layer.provideMerge(Layer.mergeAll(Layer.fresh(Workspaces.layer), Layer.fresh(Indexer.layer), fakeRuns)),
	Layer.provideMerge(fakeObjects),
);
const run = <A, E>(effect: Effect.Effect<A, E, WorkspacesTag | DocumentsTag | IndexerTag>) => runPromise(Effect.provide(effect, services));
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));

const FIXTURE = readFileSync(new URL("./fixtures/picture-pages.pdf", import.meta.url));
const file = (name: string, text: string | Uint8Array, type = "text/markdown") => new File([text as BlobPart], name, { type });
const manual = (topic: string) => `## Part 1\n\nThe ${topic}. ${"Read the whole procedure before you start. ".repeat(20)}`;
const newWorkspace = (name: string) => run(Workspaces.Workspaces.use((workspaces) => workspaces.create(ana, { kind: "private", name, description: "", instructions: "", icon: null }))).then((created) => created.id);
const upload = (workspaceId: string, name: string, topic = "vancomycin dose") => run(Documents.Documents.use((documents) => documents.upload(ana, workspaceId, file(name, manual(topic)))));
const indexer = <A, E>(use: (service: IndexerTag["Service"]) => Effect.Effect<A, E>) => run(Indexer.Indexer.use(use));

/** Holds the next call of this kind until `release`; `arrived` settles when it comes. */
function holdNext(kind: "embedding" | "page") {
	let release = () => {};
	let arrived = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const came = new Promise<void>((resolve) => (arrived = resolve));
	openRouter.gate = (called) => {
		if (called !== kind) return undefined;
		openRouter.gate = undefined;
		arrived();
		return held;
	};
	return { arrived: came, release: () => release() };
}

/** What Documents.retry and the sweep do: a new generation takes over the document. */
const takeOver = (documentId: string) =>
	database((sql) => sql<{ generation: number }>`
		update workspace_documents set status = 'reading', error = null, generation = generation + 1, index_run_id = null, reading_since = now()
		where id = ${documentId} returning generation`).then(([row]) => ({ documentId, generation: row.generation }));
const embeddedPassages = (documentId: string) =>
	database((sql) => sql<{ count: number }>`select count(*)::int as count from workspace_passages where document_id = ${documentId} and embedding is not null`).then(([row]) => row.count);

describe.skipIf(!base)("workspace document lifecycle", () => {
	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				yield* sql`insert into users (id, name, email, role) values (${who.ana}, 'ana', 'ana@example.invalid', 'user')`;
			}),
		);
		await runPromise(
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
			}),
		);
	});
	afterAll(async () => {
		await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
		await openRouter.close();
	});

	it("deletes a workspace's files only after its rows are gone for good; the sweep deletes what a crash left", async () => {
		const workspaceId = await newWorkspace("Files");
		const [first, second] = [await upload(workspaceId, "one.md"), await upload(workspaceId, "two.md")];
		const keys = [first.id, second.id].map((id) => `workspaces/${workspaceId}/${id}`);
		assert.ok(keys.every((key) => bucket.objects.has(key)));

		// The process stops while the first file is deleted.
		bucket.crashOnRemove = true;
		const stopped = await run(Workspaces.Workspaces.use((workspaces) => workspaces.remove(ana, workspaceId))).catch((error) => error);
		bucket.crashOnRemove = false;
		assert.instanceOf(stopped, Error);
		// The delete committed: no document is left whose file is gone.
		const left = await database((sql) => sql<{ count: number }>`select count(*)::int as count from workspace_documents where workspace_id = ${workspaceId}`);
		assert.strictEqual(left[0].count, 0);
		const deleted = await database((sql) => sql<{ deleted: boolean }>`select deleted_at is not null as deleted from workspaces where id = ${workspaceId}`);
		assert.isTrue(deleted[0].deleted);

		// The keys wait for the sweep, which deletes the files once they are a minute old.
		const waiting = () => database((sql) => sql<{ object_key: string }>`select object_key from workspace_object_deletions where object_key = any(${keys})`).then((rows) => rows.map((row) => row.object_key));
		assert.isNotEmpty(await waiting());
		assert.strictEqual(await run(Documents.Documents.use((documents) => documents.removeLeftObjects)), 0);
		await database((sql) => sql`update workspace_object_deletions set added_at = now() - interval '1 hour' where object_key = any(${keys})`);
		assert.isAbove(await run(Documents.Documents.use((documents) => documents.removeLeftObjects)), 0);
		assert.deepStrictEqual(await waiting(), []);
		assert.ok(keys.every((key) => !bucket.objects.has(key)));
	});

	it("a run that starts again pays for no page twice, and stops paying once the document is deleted", async () => {
		openRouter.pages.set(2, "| Drug | Dose |\n| --- | --- |\n| Cefazolin | 15 mg/kg |").set(3, "Exit site care: clean the exit site every second day.");
		const workspaceId = await newWorkspace("Restarted");
		const pdf = () => run(Documents.Documents.use((documents) => documents.upload(ana, workspaceId, file("restarted.pdf", FIXTURE, "application/pdf"))));
		const document = await pdf();
		const request = asked.at(-1)!;
		// What the run kept of page 2 before a crash cut it short.
		const calls: number[] = [];
		openRouter.gate = (kind) => (kind === "page" ? void calls.push(1) : undefined);
		// Its runs row first, as the run saves it.
		const call = { generationId: "gen-2", costUsd: 0.002, inputTokens: 1, outputTokens: 1 };
		const record = { page: 2, reason: "picture", model: "google/gemini-3.8-flash", ok: true, error: null, ms: 5, attempts: 1, ...call, reasoningTokens: 0, calls: [call], chars: 10 };
		await runPromise(
			Runs.Runs.use((runs) =>
				runs.insert({ id: `workspace-pdf:${document.id}:${request.generation}:2`, parentId: null, threadId: null, user: who.ana, functionId: "workspace-pdf", model: record.model, steps: 1, inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0.002, durationMs: 5, toolCalls: [], finishReason: "stop", generationId: "gen-2" }),
			),
		);
		await database((sql) => sql`insert into workspace_page_reads (document_id, generation, page, record, text) values (${document.id}, ${request.generation}, 2, ${sql.json(record)}, 'Kept page.')`);
		assert.deepStrictEqual(await indexer((service) => service.prepare(request)), { state: "chunked", batches: 1 });
		assert.strictEqual(calls.length, 1);
		const text = await database((sql) => sql<{ text: string }>`select text from workspace_documents where id = ${document.id}`);
		assert.include(text[0].text, "--- Page 2 ---\nKept page.");
		const pages = await database((sql) => sql<{ page: number }>`select (detail->>'page')::int as page from workspace_document_log where document_id = ${document.id} and step = 'page-read' order by 1`);
		assert.deepStrictEqual(
			pages.map((row) => row.page),
			[2, 3],
		);
		// Once the text is saved, the pages are no longer kept.
		const left = await database((sql) => sql<{ count: number }>`select count(*)::int as count from workspace_page_reads where document_id = ${document.id}`);
		assert.strictEqual(left[0].count, 0);

		// A document deleted while its run reads pays for no page after.
		const deleted = await pdf();
		await run(Documents.Documents.use((documents) => documents.remove(ana, workspaceId, deleted.id)));
		calls.length = 0;
		assert.deepStrictEqual(await indexer((service) => service.prepare(asked.at(-1)!)), { state: "gone" });
		openRouter.gate = undefined;
		assert.strictEqual(calls.length, 0);
	});

	it("an upload that races the workspace's delete adds no document to it, and leaves no file", async () => {
		const workspaceId = await newWorkspace("Racing uploads");
		const existing = await upload(workspaceId, "existing.md");
		const outcome = await runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				// The delete stops at the document the test holds, with the workspace taken.
				const hold = yield* holdRows(sql, sql`select id from workspace_documents where id = ${existing.id} for update`);
				const deleting = yield* Effect.forkChild(Workspaces.Workspaces.use((workspaces) => workspaces.remove(ana, workspaceId)));
				const deleter = yield* blockedBy(sql, hold.pid);
				const uploading = yield* Effect.forkChild(Effect.flip(Documents.Documents.use((documents) => documents.upload(ana, workspaceId, file("late.md", manual("heparin dose"))))));
				yield* Effect.raceFirst(Effect.asVoid(Fiber.await(uploading)), Effect.asVoid(blockedBy(sql, deleter)));
				yield* hold.release;
				yield* Fiber.join(deleting);
				return yield* Fiber.join(uploading);
			}).pipe(Effect.provide(services)),
		);
		assert.strictEqual(outcome._tag, "WorkspaceNotFound");
		const left = await database((sql) => sql<{ count: number }>`select count(*)::int as count from workspace_documents where workspace_id = ${workspaceId}`);
		assert.strictEqual(left[0].count, 0);
		assert.deepStrictEqual(
			[...bucket.objects.keys()].filter((key) => key.startsWith(`workspaces/${workspaceId}/`)),
			[],
		);
	});

	it("an embedding call that a newer run overtakes writes nothing into the new run's passages", async () => {
		const workspaceId = await newWorkspace("Overtaken");
		const document = await upload(workspaceId, "slow.md");
		const old = asked.at(-1)!;
		assert.deepStrictEqual(await indexer((service) => service.prepare(old)), { state: "chunked", batches: 1 });

		const hold = holdNext("embedding");
		const slow = indexer((service) => service.embedBatch(old, 0));
		await hold.arrived;
		// While the old call waits on OpenRouter, a new run starts and splits the text again.
		const latest = await takeOver(document.id);
		assert.deepStrictEqual(await indexer((service) => service.prepare(latest)), { state: "chunked", batches: 1 });
		hold.release();
		await slow;

		// The passage ids are the same in both runs: the old vectors must not land in the new passages.
		assert.strictEqual(await embeddedPassages(document.id), 0);
		const logged = await database((sql) => sql<{ count: number }>`
			select count(*)::int as count from workspace_document_log where document_id = ${document.id} and generation = ${old.generation} and step = 'embedded'`);
		assert.strictEqual(logged[0].count, 0);
		assert.strictEqual(await indexer((service) => Effect.andThen(service.embedBatch(latest, 0), service.finish(latest))), "ready");
		assert.strictEqual(await indexer((service) => service.finish(old)), "gone");
		assert.strictEqual(await embeddedPassages(document.id), 1);
	});

	it("a PDF read that a newer run overtakes neither saves its text nor replaces the ready passages", async () => {
		openRouter.pages.set(2, "| Drug | Dose |\n| --- | --- |\n| Cefazolin | 15 mg/kg |").set(3, "Exit site care: clean the exit site every second day.");
		const workspaceId = await newWorkspace("Slow read");
		const document = await run(Documents.Documents.use((documents) => documents.upload(ana, workspaceId, file("slow.pdf", FIXTURE, "application/pdf"))));
		const old = asked.at(-1)!;

		const hold = holdNext("page");
		const slow = indexer((service) => service.prepare(old));
		await hold.arrived;
		// The new run reads, splits and embeds the document, and makes it ready, while the old read waits.
		const latest = await takeOver(document.id);
		assert.strictEqual(await indexer((service) => service.run(latest)), "ready");
		const passages = await embeddedPassages(document.id);
		assert.isAbove(passages, 0);
		hold.release();

		assert.deepStrictEqual(await slow, { state: "gone" });
		assert.strictEqual(await embeddedPassages(document.id), passages);
		const settled = await database((sql) => sql<{ status: string; generation: number }>`select status, generation from workspace_documents where id = ${document.id}`);
		assert.deepStrictEqual(settled[0], { status: "ready", generation: latest.generation });
		// The old read's model calls are still kept in runs: they were paid for.
		const paid = await database((sql) => sql<{ count: number }>`select count(*)::int as count from runs where id like ${`workspace-pdf:${document.id}:${old.generation}:%`}`);
		assert.strictEqual(paid[0].count, 2);
	});
});
