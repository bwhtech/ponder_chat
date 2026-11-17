/**
 * The lifecycle of workspace documents when things happen at once or stop half-way: a
 * workspace deleted while its bucket fails, an indexing step that a newer run overtakes,
 * and a first chat or an upload that races a delete. On a real Postgres
 * (TEST_DATABASE_URL), in a schema of its own, with a stand-in bucket and OpenRouter.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { base, USERS_TABLE, useTestSchema } from "../test-env.ts";
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

const file = (name: string, text: string) => new File([text], name, { type: "text/markdown" });
const manual = (topic: string) => `## Part 1\n\nThe ${topic}. ${"Read the whole procedure before you start. ".repeat(20)}`;
const newWorkspace = (name: string) => run(Workspaces.Workspaces.use((workspaces) => workspaces.create(ana, { kind: "private", name, description: "", instructions: "", icon: null }))).then((created) => created.id);
const upload = (workspaceId: string, name: string, topic = "vancomycin dose") => run(Documents.Documents.use((documents) => documents.upload(ana, workspaceId, file(name, manual(topic)))));

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
});
