/**
 * Workspace documents end to end, below Workflow: upload, the indexing run (Indexer.ts)
 * with the real reader and embedder against a stand-in OpenRouter (fake-openrouter.ts),
 * the indexing log, "Try again", the model change, delete, and who may do what through
 * the routes. On a real Postgres (TEST_DATABASE_URL), in a schema of its own that the
 * last step drops. Workflow's runtime is replaced by a fake that keeps each run asked
 * for; the test runs the Indexer for it, as the workflow's steps do.
 */
import { readFileSync } from "node:fs";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Hono } from "hono";
import type { SignedInEnv } from "../../auth.ts";
import { base, USERS_TABLE, useTestSchema } from "../test-env.ts";
import { EMBED_COST, PAGE_COST, startFakeOpenRouter } from "./fake-openrouter.ts";
import type { Documents as DocumentsService } from "./Documents.ts";
import type { IndexRequest } from "./Indexer.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_documents_${tag}`;
useTestSchema(schema);
const openRouter = await startFakeOpenRouter();
process.env.OPENROUTER_BASE_URL = openRouter.url;

const AppLayer = await import("../../runtime/layer.ts");
const { runPromise, dispose } = await import("../../runtime/runtime.ts");
const Threads = await import("../../threads/Threads.ts");
const AdminEvents = await import("../../admin/AdminEvents.ts");
const Runs = await import("../../telemetry/Runs.ts");
const Workspaces = await import("../Workspaces.ts");
const Documents = await import("./Documents.ts");
const Indexer = await import("./Indexer.ts");
const IndexRuns = await import("./IndexRuns.ts");
const { workspacesApi } = await import("../routes.ts");
const { searchWorkspace } = await import("./turn.ts");

const FIXTURE = readFileSync(new URL("./fixtures/picture-pages.pdf", import.meta.url));
const TABLE = "| Drug | Intermittent (daily) |\n| --- | --- |\n| Cefazolin | 15 mg/kg daily |";
const SCAN = "Exit site care: clean the exit site every second day.";

const who = { ana: `ana-${tag}`, bob: `bob-${tag}`, cy: `cy-${tag}`, dan: `dan-${tag}` } as const;
type Who = keyof typeof who;
const actor = (person: Who) => ({ id: who[person], email: `${person}@example.invalid` });

/** The indexing runs asked for, in order: Workflow's place. A run is live until the test ends it. */
const asked: IndexRequest[] = [];
const ended = new Set<string>();
const runIdOf = (request: IndexRequest) => `run-${request.documentId}-${request.generation}`;
const fakeRuns = Layer.succeed(
	IndexRuns.IndexRuns,
	IndexRuns.IndexRuns.of({
		start: (request) => Effect.sync(() => (asked.push(request), runIdOf(request))),
		status: (runId) => Effect.succeed(ended.has(runId) ? "ended" : "live"),
	}),
);
const onFakeWorkflow = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, Layer.fresh(Documents.layer).pipe(Layer.provide(fakeRuns)));
const documents = <A, E>(use: (service: DocumentsService["Service"]) => Effect.Effect<A, E>) => runPromise(onFakeWorkflow(Documents.Documents.use(use)));
const indexLatest = () => runPromise(Indexer.Indexer.use((indexer) => indexer.run(asked.at(-1)!)));
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));

const app = new Hono<SignedInEnv>()
	.use("*", async (c, next) => {
		const id = c.req.header("x-test-user")!;
		c.set("user", { id, email: `${id}@example.invalid`, name: id } as SignedInEnv["Variables"]["user"]);
		await next();
	})
	.route("/api/workspaces", workspacesApi);
async function call(person: Who, method: string, path: string, body?: BodyInit) {
	const response = await app.request(path, { method, headers: { "x-test-user": who[person] }, body });
	return { status: response.status, body: (await response.json()) as any };
}

/** A Markdown manual of `sections` sections of about 900 characters: one passage each. */
function manual(sections: number, topic = "vancomycin dose") {
	const body = (index: number) => `Section ${index} of the manual is about the ${topic}. ${"Read the whole procedure before you start. ".repeat(20)}`;
	return Array.from({ length: sections }, (_, index) => `## Part ${index + 1}\n\n${body(index + 1)}`).join("\n\n");
}
const file = (name: string, text: string | Uint8Array, type: string) => new File([text as BlobPart], name, { type });

const ids = { workspace: "", other: "", manual: "", pdf: "", failing: "" };

describe.skipIf(!base)("workspace documents", () => {
	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				for (const person of Object.keys(who) as Who[]) yield* sql`insert into users (id, name, email, role) values (${who[person]}, ${person}, ${`${person}@example.invalid`}, 'user')`;
			}),
		);
		await runPromise(
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
				const workspaces = yield* Workspaces.Workspaces;
				ids.workspace = (yield* workspaces.create(actor("ana"), { kind: "private", name: "Ward", description: "", instructions: "", icon: null })).id;
				ids.other = (yield* workspaces.create(actor("dan"), { kind: "private", name: "Dan's", description: "", instructions: "", icon: null })).id;
				yield* workspaces.share(actor("ana"), ids.workspace, {
					kind: "private",
					members: [
						{ userId: who.bob, access: "ask" },
						{ userId: who.cy, access: "edit" },
					],
				});
			}),
		);
	});
	afterAll(async () => {
		await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
		await openRouter.close();
	});

	it("reads, splits and embeds an upload in batches of 96, and makes it ready, with a location line on each passage", async () => {
		const uploaded = await documents((service) => service.upload(actor("ana"), ids.workspace, file("ward-manual.md", manual(120), "text/markdown")));
		ids.manual = uploaded.id;
		assert.deepStrictEqual([uploaded.status, uploaded.name, uploaded.mediaType, uploaded.error], ["reading", "ward-manual.md", "text/markdown", null]);
		assert.deepStrictEqual(asked.at(-1), { documentId: uploaded.id, generation: 1 });

		assert.strictEqual(await indexLatest(), "ready");
		const passages = await database((sql) => sql<{ location: string; model: string; ordinal: number }>`select location, model, ordinal from workspace_passages where document_id = ${uploaded.id} order by ordinal`);
		assert.strictEqual(passages.length, 120);
		assert.strictEqual(passages[4].location, "ward-manual.md › Part 5");
		assert.ok(passages.every((passage) => passage.model === "qwen/qwen3-embedding-8b"));
		// Two calls: 96, then 24.
		assert.deepStrictEqual(
			openRouter.embedded.slice(-2).map((batch) => batch.length),
			[96, 24],
		);
		// Everyone who can ask sees it ready.
		const answer = await call("bob", "GET", `/api/workspaces/${ids.workspace}`);
		assert.deepStrictEqual(
			answer.body.workspace.documents.map((document: { id: string; status: string }) => [document.id, document.status]),
			[[uploaded.id, "ready"]],
		);
		assert.deepStrictEqual(Object.keys(answer.body.workspace.documents[0]).sort(), ["createdAt", "error", "id", "mediaType", "name", "size", "status"]);
	});

	it("a run that is asked again skips what it did: no batch is embedded twice", async () => {
		const calls = openRouter.embedded.length;
		const request = { documentId: ids.manual, generation: 1 };
		await runPromise(Indexer.Indexer.use((indexer) => Effect.all([indexer.embedBatch(request, 0), indexer.embedBatch(request, 1)])));
		assert.strictEqual(openRouter.embedded.length, calls);
	});

	it("logs each step of a PDF with a picture page, with the cost of its runs row, and never the text", async () => {
		openRouter.pages.set(2, TABLE).set(3, SCAN);
		ids.pdf = (await documents((service) => service.upload(actor("cy"), ids.workspace, file("peritonitis.pdf", FIXTURE, "application/pdf")))).id;
		assert.strictEqual(await indexLatest(), "ready");

		const log = await documents((service) => service.log(actor("ana"), ids.workspace, ids.pdf));
		assert.strictEqual(log.document.status, "ready");
		assert.deepStrictEqual(
			log.steps.map((step) => step.step),
			["uploaded", "parsed", "page-read", "page-read", "chunked", "embedded", "ready"],
		);
		const [uploaded, parsed, table, scan] = log.steps;
		assert.deepStrictEqual(uploaded.detail, { size: FIXTURE.length, mediaType: "application/pdf", by: who.cy });
		assert.deepStrictEqual([table.detail.page, table.detail.reason, table.detail.ok, table.costUsd], [2, "picture", true, PAGE_COST]);
		assert.deepStrictEqual([scan.detail.page, scan.detail.reason], [3, "scan"]);
		assert.deepStrictEqual([parsed.detail.engine, parsed.detail.pages], ["liteparse", 3]);

		// Each cost is its runs row's; the last row adds them up.
		const runs = await database((sql) => sql<{ id: string; function_id: string; user: string; cost: number }>`
			select id, function_id, "user", cost_usd::float8 as cost from runs where id like ${`%:${ids.pdf}:%`} order by id`);
		assert.deepStrictEqual(
			runs.map((run) => [run.id, run.function_id, run.user]),
			[
				[`workspace-index:${ids.pdf}:1:0`, "workspace-index", who.cy],
				[`workspace-pdf:${ids.pdf}:1:2`, "workspace-pdf", who.cy],
				[`workspace-pdf:${ids.pdf}:1:3`, "workspace-pdf", who.cy],
			],
		);
		const embedded = log.steps.find((step) => step.step === "embedded")!;
		assert.strictEqual(embedded.costUsd, runs[0].cost);
		const total = runs.reduce((sum, run) => sum + run.cost, 0);
		assert.closeTo(log.steps.at(-1)!.costUsd!, total, 1e-9);

		// Numbers, names and errors only: no page's text, the model's or the text layer's.
		const rows = JSON.stringify(await database((sql) => sql`select detail from workspace_document_log where document_id = ${ids.pdf}`));
		for (const text of ["Cefazolin", "Exit site", "Peritonitis is the main infection", "cloudy bag"]) assert.notInclude(rows, text);
	});

	it("fails a document whose page has no text and can't be read, with the page; Try again makes it ready", async () => {
		openRouter.pages.set(3, "fail");
		ids.failing = (await documents((service) => service.upload(actor("ana"), ids.workspace, file("scan.pdf", FIXTURE, "application/pdf")))).id;
		assert.strictEqual(await indexLatest(), "failed");
		const failed = await documents((service) => service.log(actor("ana"), ids.workspace, ids.failing));
		assert.strictEqual(failed.document.status, "failed");
		assert.include(failed.document.error!, "Page 3");
		const last = failed.steps.at(-1)!;
		assert.deepStrictEqual([last.step, last.detail.step, last.detail.page], ["failed", "page-read", 3]);
		assert.include(String(last.detail.error), "Page 3");
		const pageRead = failed.steps.find((step) => step.step === "page-read" && step.detail.page === 3)!;
		assert.deepStrictEqual([pageRead.detail.ok, pageRead.detail.error], [false, "Provider returned error"]);

		// The bytes are read again, and the page this time.
		openRouter.pages.set(3, SCAN);
		const again = await documents((service) => service.retry(actor("ana"), ids.workspace, ids.failing));
		assert.deepStrictEqual([again.status, again.error], ["reading", null]);
		assert.deepStrictEqual(asked.at(-1), { documentId: ids.failing, generation: 2 });
		assert.strictEqual(await indexLatest(), "ready");
		const steps = (await documents((service) => service.log(actor("ana"), ids.workspace, ids.failing))).steps;
		assert.deepStrictEqual(steps.find((step) => step.step === "reindexed")?.detail, { reason: "asked", by: who.ana });
		assert.strictEqual(steps.at(-1)!.step, "ready");
		// Only a failed document can be tried again.
		const refused = await documents((service) => service.retry(actor("ana"), ids.workspace, ids.failing)).catch((error) => error);
		assert.strictEqual(refused._tag, "DocumentNotFailed");
	});

	it("indexes again the documents that another embedding model made, at start-up; search works meanwhile", async () => {
		// The old model's vectors are 5 wide, the fake's 3: a search that read them would fail.
		await database((sql) => sql`update workspace_passages set model = 'old/embedding', embedding = '[1,0,0,0,0]'::vector where document_id = ${ids.manual}`);
		const search = () =>
			runPromise(searchWorkspace({ owner: who.ana, workspaceId: ids.workspace, threadId: `thread-${tag}`, query: "vancomycin dose", documentIds: [ids.manual, ids.pdf] }));
		// Until the run ends, the manual is only not found.
		assert.notInclude((await search()).map((excerpt) => excerpt.documentId), ids.manual);

		assert.strictEqual(await documents((service) => service.reindexOutdated), 1);
		const request = asked.at(-1)!;
		assert.strictEqual(request.documentId, ids.manual);
		assert.strictEqual(await indexLatest(), "ready");
		const log = (await documents((service) => service.log(actor("ana"), ids.workspace, ids.manual))).steps.filter((step) => step.generation === request.generation);
		assert.deepStrictEqual(
			log.map((step) => step.step),
			["reindexed", "chunked", "embedded", "embedded", "ready"],
		);
		assert.deepStrictEqual(log[0].detail, { reason: "model-changed", from: "old/embedding", to: "qwen/qwen3-embedding-8b" });
		assert.strictEqual(await documents((service) => service.reindexOutdated), 0);
		assert.include((await search()).map((excerpt) => excerpt.documentId), ids.manual);
	});

	it("embeds one passage a call when the model takes no more, with one runs row for the batch", async () => {
		openRouter.oneAtATime = true;
		const uploaded = await documents((service) => service.upload(actor("ana"), ids.workspace, file("short.md", manual(3), "text/markdown")));
		assert.strictEqual(await indexLatest(), "ready");
		openRouter.oneAtATime = false;
		const [run] = await database((sql) => sql<{ steps: number; cost: number }>`
			select steps, cost_usd::float8 as cost from runs where id = ${`workspace-index:${uploaded.id}:1:0`}`);
		assert.strictEqual(run.steps, 3);
		assert.closeTo(run.cost, 3 * EMBED_COST, 1e-9);
		assert.deepStrictEqual(
			openRouter.embedded.slice(-3).map((call) => call.length),
			[1, 1, 1],
		);
	});

	it("keeps the cost of the calls that worked when one passage fails, and pays only for that one on the next try", async () => {
		openRouter.oneAtATime = true;
		const uploaded = await documents((service) => service.upload(actor("ana"), ids.workspace, file("flaky.md", manual(3, "exit site care"), "text/markdown")));
		const request = asked.at(-1)!;
		const prepared = await runPromise(Indexer.Indexer.use((indexer) => indexer.prepare(request)));
		assert.deepStrictEqual(prepared, { state: "chunked", batches: 1 });

		// The passage of Part 2 fails on every try: the AI SDK tries each call 3 times.
		let refused = 0;
		openRouter.failEmbedding = (input) => input.some((text) => text.includes("Part 2")) && ++refused > 0;
		const calls = openRouter.embedded.length;
		const failed = await runPromise(Indexer.Indexer.use((indexer) => Effect.flip(indexer.embedBatch(request, 0))));
		assert.strictEqual(failed._tag, "EmbeddingFailed");
		assert.strictEqual(refused, 3);
		assert.strictEqual(openRouter.embedded.length - calls, 2);
		const spent = () =>
			database((sql) => sql<{ steps: number; cost: number }>`
				select coalesce(sum(steps), 0)::int as steps, coalesce(sum(cost_usd), 0)::float8 as cost from runs where id like ${`workspace-index:${uploaded.id}:1:0%`}`).then(([row]) => row);
		const afterFailure = await spent();
		assert.strictEqual(afterFailure.steps, 2);
		assert.closeTo(afterFailure.cost, 2 * EMBED_COST, 1e-9);

		// The next try embeds only the passage that failed.
		openRouter.failEmbedding = undefined;
		await runPromise(Indexer.Indexer.use((indexer) => indexer.embedBatch(request, 0)));
		const again = openRouter.embedded.slice(calls + 2);
		assert.strictEqual(again.length, 1);
		assert.include(again[0][0], "Part 2");
		assert.strictEqual(await runPromise(Indexer.Indexer.use((indexer) => indexer.finish(request))), "ready");
		const total = await spent();
		assert.strictEqual(total.steps, 3);
		assert.closeTo(total.cost, 3 * EMBED_COST, 1e-9);
		openRouter.oneAtATime = false;
		// The AI SDK waits 2 s, then 4 s, between its tries.
	}, 20_000);

	it("indexes again a document left Reading with no live run, once; one whose run is live or just started is left alone", async () => {
		const upload = (name: string) => documents((service) => service.upload(actor("ana"), ids.workspace, file(name, manual(1), "text/markdown"))).then((document) => document.id);
		const [neverStarted, runEnded, runLive, justUploaded] = [await upload("never.md"), await upload("ended.md"), await upload("live.md"), await upload("new.md")];
		// A crash between the upload's transaction and the start of its run; a run that ended without settling the document.
		await database((sql) => sql`update workspace_documents set index_run_id = null where id = ${neverStarted} or id = ${justUploaded}`);
		await database((sql) => sql`update workspace_documents set reading_since = now() - interval '1 hour' where id in (${neverStarted}, ${runEnded}, ${runLive})`);
		ended.add(runIdOf({ documentId: runEnded, generation: 1 }));

		const before = asked.length;
		assert.strictEqual(await documents((service) => service.restartStalled), 2);
		assert.sameDeepMembers(asked.slice(before), [
			{ documentId: neverStarted, generation: 2 },
			{ documentId: runEnded, generation: 2 },
		]);
		const log = (await documents((service) => service.log(actor("ana"), ids.workspace, neverStarted))).steps;
		assert.deepStrictEqual(log.at(-1)!.detail, { reason: "stalled" });
		// Their new runs are live: the next sweep starts nothing.
		assert.strictEqual(await documents((service) => service.restartStalled), 0);
		assert.strictEqual(await runPromise(Indexer.Indexer.use((indexer) => indexer.run({ documentId: neverStarted, generation: 2 }))), "ready");

		// Try again: refused while the run is live or the document has only just started.
		for (const id of [runLive, justUploaded]) {
			const refused = await documents((service) => service.retry(actor("ana"), ids.workspace, id)).catch((error) => error);
			assert.strictEqual(refused._tag, "DocumentNotFailed");
		}
		// Once the run ended, an editor may start it again.
		ended.add(runIdOf({ documentId: runLive, generation: 1 }));
		const again = await documents((service) => service.retry(actor("ana"), ids.workspace, runLive));
		assert.strictEqual(again.status, "reading");
		assert.deepStrictEqual(asked.at(-1), { documentId: runLive, generation: 2 });
	});

	it("lets only people who can edit upload, delete, read the log and try again; others get 403, and non-members 404", async () => {
		const form = () => {
			const data = new FormData();
			data.set("file", file("notes.txt", "Some notes.", "text/plain"));
			return data;
		};
		const paths = {
			upload: `/api/workspaces/${ids.workspace}/documents`,
			remove: `/api/workspaces/${ids.workspace}/documents/${ids.pdf}`,
			log: `/api/workspaces/${ids.workspace}/documents/${ids.pdf}/log`,
			retry: `/api/workspaces/${ids.workspace}/documents/${ids.pdf}/retry`,
		};
		for (const [person, status] of [
			["bob", 403],
			["dan", 404],
		] as const) {
			assert.strictEqual((await call(person, "POST", paths.upload, form())).status, status, `${person} upload`);
			assert.strictEqual((await call(person, "DELETE", paths.remove)).status, status, `${person} delete`);
			assert.strictEqual((await call(person, "GET", paths.log)).status, status, `${person} log`);
			assert.strictEqual((await call(person, "POST", paths.retry)).status, status, `${person} retry`);
		}
		assert.strictEqual((await call("dan", "GET", `/api/workspaces/${ids.workspace}`)).status, 404);

		// An editor reads the log; a document of another workspace is not found in this one.
		const log = await call("cy", "GET", paths.log);
		assert.strictEqual(log.status, 200);
		assert.deepStrictEqual(Object.keys(log.body).sort(), ["document", "steps"]);
		assert.deepStrictEqual(Object.keys(log.body.steps[0]).sort(), ["at", "costUsd", "detail", "generation", "step"]);
		assert.strictEqual((await call("cy", "GET", `/api/workspaces/${ids.other}/documents/${ids.pdf}/log`)).status, 404);
		assert.strictEqual((await call("dan", "GET", `/api/workspaces/${ids.other}/documents/${ids.pdf}/log`)).status, 404);
		// A ready document can't be tried again; a file that is not a document is refused.
		assert.strictEqual((await call("cy", "POST", paths.retry)).status, 409);
		const image = new FormData();
		image.set("file", file("photo.png", new Uint8Array([137, 80, 78, 71]), "image/png"));
		const refused = await call("cy", "POST", paths.upload, image);
		assert.deepStrictEqual([refused.status, refused.body.error], [400, '"photo.png" can\'t be read. Upload a PDF, or a text, Markdown, CSV, TSV or JSON file.']);
	});

	it("deletes a document with its passages and log, and a workspace with all of its documents", async () => {
		assert.strictEqual((await call("cy", "DELETE", `/api/workspaces/${ids.workspace}/documents/${ids.pdf}`)).status, 200);
		const counts = (documentId: string) =>
			database((sql) =>
				sql<{ passages: number; log: number }>`
					select (select count(*)::int from workspace_passages where document_id = ${documentId}) as passages,
						(select count(*)::int from workspace_document_log where document_id = ${documentId}) as log`,
			).then(([row]) => row);
		assert.deepStrictEqual(await counts(ids.pdf), { passages: 0, log: 0 });
		// Its spend stays in runs, by the document's id.
		const spent = await database((sql) => sql<{ count: number }>`select count(*)::int as count from runs where id like ${`workspace-%:${ids.pdf}:%`}`);
		assert.ok(spent[0].count > 0);

		await runPromise(Workspaces.Workspaces.use((workspaces) => workspaces.remove(actor("ana"), ids.workspace)));
		const left = await database((sql) => sql<{ count: number }>`select count(*)::int as count from workspace_documents where workspace_id = ${ids.workspace}`);
		assert.strictEqual(left[0].count, 0);
		assert.deepStrictEqual(await counts(ids.manual), { passages: 0, log: 0 });
	});
});
