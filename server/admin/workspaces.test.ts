/**
 * Workspaces as admins see them, through /api/admin (routes.ts, workspaces/admin.ts), and
 * the "System" line of the overview, on a real Postgres (TEST_DATABASE_URL), in a schema of
 * their own that the last step drops. The routes run behind a stand-in for the session
 * check of app.ts, which takes the person from a header. Documents and their log are
 * written straight to the tables: documents/documents.test.ts tests the indexer that
 * writes them.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { Hono } from "hono";
import type { SignedInEnv } from "../auth.ts";
import { parseJson } from "../test-json.ts";
import type { DocumentLog, WorkspacesReport } from "../workspaces/admin.ts";
import { base, USERS_TABLE, useTestSchema } from "../workspaces/test-env.ts";
import type { ActivityPage } from "./AdminReports.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_admin_workspaces_${tag}`;
useTestSchema(schema);

const { runPromise, dispose } = await import("../runtime/runtime.ts");
const Threads = await import("../threads/Threads.ts");
const AdminEvents = await import("./AdminEvents.ts");
const Credits = await import("../credits/Credits.ts");
const Runs = await import("../telemetry/Runs.ts");
const Workspaces = await import("../workspaces/Workspaces.ts");
const { indexLog } = await import("../workspaces/documents/log.ts");
const { adminApi } = await import("./routes.ts");

const who = { admin: `admin-${tag}`, ana: `ana-${tag}`, bob: `bob-${tag}` } as const;
type Who = keyof typeof who;
const actor = (person: Who) => ({ id: who[person], email: `${person}-${tag}@example.invalid` });

/** What must never reach an admin: the private workspace's name, its documents' names, its owner. */
const SECRET = { workspace: `Zanzibar Plans ${tag}`, document: `Quixotic Ledger ${tag}.pdf`, readyDocument: `Marmalade Notes ${tag}.md`, ownerName: `Anastasia Pemberton ${tag}` };

const app = new Hono<SignedInEnv>()
	.use("*", async (c, next) => {
		const id = c.req.header("x-test-user")!;
		c.set("user", { id, email: `${id}@example.invalid`, name: id } as SignedInEnv["Variables"]["user"]);
		await next();
	})
	.route("/api/admin", adminApi);

async function call(person: Who, path: string, method = "GET") {
	const response = await app.request(path, { method, headers: { "x-test-user": who[person] } });
	return { status: response.status, text: await response.text() };
}
const json = async <Body>(person: Who, path: string) => {
	const answer = await call(person, path);
	assert.strictEqual(answer.status, 200, answer.text);
	return parseJson<Body>(answer.text);
};
/** The parts of the Overview page (GET /api/admin/overview) that the tests read. */
type Overview = {
	people: { id: string; credits: number; replies: number }[];
	system: { usd: number; calls: number; byFunction: { functionId: string; usd: number }[] };
	today: { credits: number };
};
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));

/** A system or reply run, as the indexer, the title or the chat write them. */
const run = (id: string, user: string, functionId: string, costUsd: number) =>
	Runs.Runs.use((runs) =>
		runs.insert({
			id,
			parentId: null,
			threadId: null,
			user,
			functionId,
			model: "test/model",
			steps: 1,
			inputTokens: 10,
			outputTokens: 0,
			cachedTokens: 0,
			costUsd,
			durationMs: 5,
			toolCalls: [],
			finishReason: "stop",
		}),
	);

const ids = { org: "", private: "", orgDocument: `org-doc-${tag}`, failed: `private-failed-${tag}`, ready: `private-ready-${tag}` };

/** A document row with the status it ended in. */
const document = (id: string, workspaceId: string, name: string, status: string, error: string | null, by: string) =>
	PgClient.PgClient.use(
		(sql) => sql`
			insert into workspace_documents (id, workspace_id, name, media_type, size, status, error, added_by)
			values (${id}, ${workspaceId}, ${name}, 'text/markdown', 1200, ${status}, ${error}, ${by})`,
	);

/** An indexing run's log: uploaded, one embedded batch with its `runs` row, then ready. */
const indexed = (documentId: string, workspaceId: string, by: string, costUsd: number) =>
	Effect.gen(function* () {
		const log = indexLog(yield* PgClient.PgClient);
		const runId = `workspace-index:${documentId}:1:0`;
		yield* run(runId, by, "workspace-index", costUsd);
		yield* log.write({ documentId, workspaceId, generation: 1, step: "uploaded", detail: { size: 1200, mediaType: "text/markdown", by } });
		yield* log.write({ documentId, workspaceId, generation: 1, step: "embedded", part: 0, detail: { batch: 0, passages: 3, model: "test/embed", ms: 4 }, runId });
		yield* log.write({ documentId, workspaceId, generation: 1, step: "ready", detail: { passages: 3, ms: 9 } });
	});

describe.skipIf(!base)("workspaces and system spend on /admin", () => {
	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				yield* sql`insert into users (id, name, email, role) values (${who.admin}, 'Admin', ${actor("admin").email}, 'admin')`;
				yield* sql`insert into users (id, name, email, role) values (${who.ana}, ${SECRET.ownerName}, ${actor("ana").email}, 'user')`;
				yield* sql`insert into users (id, name, email, role) values (${who.bob}, 'Bob', ${actor("bob").email}, 'user')`;
			}),
		);
		await runPromise(
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Credits.Credits.use((credits) => credits.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
				const workspaces = yield* Workspaces.Workspaces;
				ids.org = (yield* workspaces.create(actor("admin"), { kind: "org", name: "Handbook", description: "For everyone", instructions: "Be brief.", icon: null })).id;
				ids.private = (yield* workspaces.create(actor("ana"), { kind: "private", name: SECRET.workspace, description: "Mine", instructions: "Secret.", icon: null })).id;

				yield* document(ids.orgDocument, ids.org, "handbook.md", "ready", null, who.admin);
				yield* indexed(ids.orgDocument, ids.org, who.admin, 0.002);
				// The indexer's error can hold a model's message, which can name the document or the workspace.
				const error = `Page 3 of “${SECRET.document}” in ${SECRET.workspace.toUpperCase()} could not be read. Try again.`;
				yield* document(ids.failed, ids.private, SECRET.document, "failed", error, who.ana);
				yield* document(ids.ready, ids.private, SECRET.readyDocument, "ready", null, who.ana);
				yield* indexed(ids.ready, ids.private, who.ana, 0.003);
			}),
		);
	});

	afterAll(async () => {
		if (base) await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
	});

	it("refuses people who are not admins", async () => {
		assert.strictEqual((await call("bob", "/api/admin/workspaces")).status, 403);
		assert.strictEqual((await call("bob", `/api/admin/workspaces/${ids.org}/documents/${ids.orgDocument}/log`)).status, 403);
		assert.strictEqual((await call("ana", "/api/admin/workspaces")).status, 403, "owning a workspace makes no one an admin");
	});

	it("shows organisation workspaces with their owner, documents, statuses and cost", async () => {
		const report = await json<WorkspacesReport>("admin", "/api/admin/workspaces");
		assert.lengthOf(report.org, 1);
		const [handbook] = report.org;
		assert.deepInclude(handbook, { id: ids.org, name: "Handbook", description: "For everyone", costUsd: 0.002 });
		assert.deepStrictEqual(handbook.owner, { id: who.admin, name: "Admin", email: actor("admin").email });
		assert.deepStrictEqual(
			handbook.documents.map((doc) => [doc.id, doc.name, doc.status, doc.error, doc.costUsd]),
			[[ids.orgDocument, "handbook.md", "ready", null, 0.002]],
		);
	});

	it("gives an organisation document's full log, with the cost of each step from runs", async () => {
		const log = await json<DocumentLog>("admin", `/api/admin/workspaces/${ids.org}/documents/${ids.orgDocument}/log`);
		assert.deepInclude(log.document, { id: ids.orgDocument, name: "handbook.md", status: "ready" });
		assert.deepStrictEqual(
			log.steps.map((step) => [step.step, step.costUsd]),
			[
				["uploaded", null],
				["embedded", 0.002],
				["ready", 0.002],
			],
		);
		assert.deepStrictEqual(log.steps[0].detail, { size: 1200, mediaType: "text/markdown", by: who.admin });
	});

	it("does not open a private document's log, or a document through another workspace", async () => {
		assert.strictEqual((await call("admin", `/api/admin/workspaces/${ids.private}/documents/${ids.failed}/log`)).status, 404);
		assert.strictEqual((await call("admin", `/api/admin/workspaces/${ids.org}/documents/${ids.failed}/log`)).status, 404);
		assert.strictEqual((await call("admin", `/api/admin/workspaces/${ids.org}/documents/nothing-${tag}/log`)).status, 404);
		// The normal route does not open it either: an admin is no one special in a private workspace.
		assert.strictEqual(await runPromise(Workspaces.Workspaces.use((workspaces) => workspaces.accessOf(who.admin, ids.private))), "none");
	});

	it("sums private workspaces up, without a name, a document, an owner or an id", async () => {
		const answer = await call("admin", "/api/admin/workspaces");
		const report = parseJson<WorkspacesReport>(answer.text);
		assert.deepStrictEqual(report.private, {
			workspaces: 1,
			documents: { reading: 0, ready: 1, failed: 1 },
			costUsd: 0.003,
			errors: [{ error: "Page 3 of “…” in … could not be read. Try again.", documents: 1 }],
		});
		for (const secret of [...Object.values(SECRET), "Zanzibar", "Quixotic", "Marmalade", "Anastasia", who.ana, actor("ana").email, ids.private, ids.failed, ids.ready]) {
			assert.notInclude(answer.text.toLowerCase(), secret.toLowerCase(), `"${secret}" is in the answer`);
		}
	});

	it("shows the System line per function id for the range, apart from replies, and leaves each person's credits as they were", async () => {
		const people = async () =>
			(await json<Overview>("admin", "/api/admin/overview?days=7")).people.map(({ id, credits, replies }) => ({ id, credits, replies }));
		await runPromise(run(`chat-${tag}`, who.ana, "chat", 0.01));
		const before = await people();
		assert.deepInclude(before, { id: who.ana, credits: 10, replies: 1 });

		await runPromise(
			Effect.all([
				run(`title-${tag}`, who.ana, "thread-title", 0.0005),
				run(`search-${tag}`, who.bob, "workspace-search", 0.0001),
				run(`pdf-${tag}`, who.bob, "workspace-pdf", 0.004),
				run(`memory-${tag}`, who.bob, "memory-embed", 0.00002),
			]),
		);
		// Before the range: 8 days ago, for 7 days.
		await database((sql) => sql`update runs set created_at = now() - interval '8 days' where id = ${`search-${tag}`}`);

		const overview = await json<Overview>("admin", "/api/admin/overview?days=7");
		const cost = Object.fromEntries(overview.system.byFunction.map((line) => [line.functionId, line.usd]));
		assert.deepStrictEqual(cost, { "thread-title": 0.0005, "memory-embed": 0.00002, "workspace-index": 0.005, "workspace-pdf": 0.004, "workspace-search": 0 });
		assert.strictEqual(overview.system.usd, 0.00952);
		assert.strictEqual(overview.system.calls, 5, "two index runs, a title, a page and a memory embedding: not the reply");
		assert.deepStrictEqual(await people(), before);
		assert.strictEqual(overview.today.credits, 10);

		const month = await json<Overview>("admin", "/api/admin/overview?days=30");
		assert.strictEqual(month.system.byFunction.find((line) => line.functionId === "workspace-search")?.usd, 0.0001);
	});

	it("logs an organisation workspace's changes with the length of its instructions, not their text", async () => {
		const long = "Answer from the handbook. ".repeat(800);
		await runPromise(Workspaces.Workspaces.use((workspaces) => workspaces.update(actor("admin"), ids.org, { instructions: long })));
		await runPromise(Workspaces.Workspaces.use((workspaces) => workspaces.share(actor("admin"), ids.org, { kind: "org", members: [] })));
		const answer = await call("admin", "/api/admin/activity");
		const { events } = parseJson<ActivityPage>(answer.text);
		assert.notInclude(answer.text, long);
		const update = events.find((event) => event.action === "update-workspace");
		assert.deepInclude(update?.before, { name: "Handbook", instructionsLength: "Be brief.".length });
		assert.deepInclude(update?.after, { name: "Handbook", instructionsLength: long.length, instructionsChanged: true });
		assert.notProperty(update?.after, "instructions");
		const share = events.find((event) => event.action === "share-workspace");
		assert.deepInclude(share?.after, { workspace: ids.org, kind: "org", name: "Handbook" });
	});

	it("names no workspace that is private now, also one deleted while private, and keeps the name of one deleted while for everyone", async () => {
		const madeForEveryone = (name: string) =>
			runPromise(
				Workspaces.Workspaces.use((workspaces) =>
					workspaces.create(actor("admin"), { kind: "org", name, description: `${name} description`, instructions: `${name} instructions`, icon: null }),
				),
			);
		const hidden = await madeForEveryone(`Obsidian Harbour ${tag}`);
		const gone = await madeForEveryone(`Velvet Quarry ${tag}`);
		const kept = await madeForEveryone(`Copper Atlas ${tag}`);
		await runPromise(
			Workspaces.Workspaces.use((workspaces) =>
				Effect.gen(function* () {
					yield* workspaces.update(actor("admin"), hidden.id, { name: `Obsidian Lighthouse ${tag}`, instructions: "Longer instructions here." });
					yield* workspaces.share(actor("admin"), hidden.id, { kind: "private", members: [{ userId: who.bob, access: "ask" }] });
					yield* workspaces.share(actor("admin"), gone.id, { kind: "private", members: [] });
					yield* workspaces.remove(actor("admin"), gone.id);
					yield* workspaces.remove(actor("admin"), kept.id);
				}),
			),
		);

		const answer = await call("admin", "/api/admin/activity");
		for (const secret of ["Obsidian", "Lighthouse", "Velvet", "Quarry", hidden.id, gone.id, who.bob]) {
			assert.notInclude(answer.text, secret, `"${secret}" is in the answer`);
		}
		const { events } = parseJson<ActivityPage>(answer.text);
		const of = (action: string) => events.filter((event) => event.action === action);
		assert.include(
			of("create-workspace").map((event) => event.after?.name),
			`Copper Atlas ${tag}`,
		);
		assert.deepStrictEqual(
			of("delete-workspace").map((event) => event.before?.name),
			[`Copper Atlas ${tag}`],
		);
		// Still says what happened, as “Made a workspace private”, with nothing that tells which.
		const madePrivate = of("share-workspace").filter((event) => event.after?.kind === "private");
		assert.deepStrictEqual(
			madePrivate.map((event) => [event.before, event.after]),
			[
				[{ kind: "org" }, { kind: "private" }],
				[{ kind: "org" }, { kind: "private" }],
			],
		);
		const unnamed = events.filter((event) => event.action.endsWith("-workspace") && event.before?.name === undefined && event.after?.name === undefined);
		assert.lengthOf(unnamed, 5, "two made, one edited, two made private");
		for (const event of unnamed) {
			assert.deepStrictEqual([...Object.keys(event.before ?? {}), ...Object.keys(event.after ?? {})].filter((key) => key !== "kind"), [], "a private workspace's event keeps its kind only");
		}
	});
});
