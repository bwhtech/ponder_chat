/**
 * What a chat turn gets from its workspace's documents: the inline or search choice at the
 * edge of the budget, the order of hybrid search, and that search reads only one
 * workspace's ready passages of the current model. Also that the app's own calls cost
 * nobody credits. The pure parts run anywhere; the rest on a real Postgres
 * (TEST_DATABASE_URL), in a schema of its own, with a stand-in OpenRouter.
 */
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type { Services } from "../../runtime/layer.ts";
import { base, USERS_TABLE, useTestSchema } from "../test-env.ts";
import { chooseInline, inlineBudget, MAX_INLINE_CHARS } from "./budget.ts";
import { EMBED_COST, meaning, startFakeOpenRouter } from "./fake-openrouter.ts";
import { keywordQuery } from "./passages.ts";

describe("the inline or search choice", () => {
	const docs = [
		{ id: "a", chars: 100 },
		{ id: "b", chars: 300 },
		{ id: "c", chars: 200 },
	];

	it("puts every document in whole when all of them fit, to the last character", () => {
		assert.deepStrictEqual(chooseInline(docs, 600), { inline: docs, search: [] });
	});

	it("moves the largest to search first, one character past the budget, until the rest fit", () => {
		assert.deepStrictEqual(chooseInline(docs, 599), { inline: [docs[0], docs[2]], search: [docs[1]] });
		assert.deepStrictEqual(chooseInline(docs, 299), { inline: [docs[0]], search: [docs[1], docs[2]] });
		assert.deepStrictEqual(chooseInline(docs, 99), { inline: [], search: [docs[1], docs[2], docs[0]] });
	});

	it("gives half of the window at 4 characters a token, never past the limit for files in one call", () => {
		assert.strictEqual(inlineBudget(100_000), 200_000);
		assert.strictEqual(inlineBudget(150_000), MAX_INLINE_CHARS);
		assert.strictEqual(inlineBudget(1_000_000), MAX_INLINE_CHARS);
		assert.strictEqual(inlineBudget(32_000), 64_000);
		assert.strictEqual(inlineBudget(null), 256_000);
	});

	it("searches for any of the question's words, leaving out short and common ones", () => {
		assert.strictEqual(keywordQuery("What is the dose of Vancomycin, in mg/kg?"), "dose | vancomycin");
		assert.strictEqual(keywordQuery("ಬೆಂಗಳೂರು ಆಸ್ಪತ್ರೆ"), "ಬೆಂಗಳೂರು | ಆಸ್ಪತ್ರೆ");
		assert.strictEqual(keywordQuery("a & | ! ()"), "");
	});
});

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_doc_search_${tag}`;
useTestSchema(schema);
const openRouter = await startFakeOpenRouter();
process.env.OPENROUTER_BASE_URL = openRouter.url;

const { runPromise, dispose } = await import("../../runtime/runtime.ts");
const Threads = await import("../../threads/Threads.ts");
const AdminEvents = await import("../../admin/AdminEvents.ts");
const Runs = await import("../../telemetry/Runs.ts");
const Credits = await import("../../credits/Credits.ts");
const Settings = await import("../../settings/Settings.ts");
const Workspaces = await import("../Workspaces.ts");
const Invites = await import("../../people/Invites.ts");
const Teams = await import("../../teams/Teams.ts");
const { passageStore } = await import("./passages.ts");
const { RETRIEVAL_BUDGET, searchWorkspace, workspaceTurn } = await import("./turn.ts");
const { EMBED_TIMEOUT } = await import("../../openrouter/embeddings.ts");
const { excerptsBlock } = await import("../prompt.ts");

const MODEL = "qwen/qwen3-embedding-8b";
const ana = `ana-${tag}`;
const bob = `bob-${tag}`;
const database = <A>(work: (sql: PgClient.PgClient) => Effect.Effect<A, unknown>) => runPromise(PgClient.PgClient.use(work).pipe(Effect.orDie));
const ids = { ward: "", other: "" };

/** A ready (or not) document with passages whose vectors are given, as indexing would leave them. */
async function seed(workspaceId: string, name: string, passages: { content: string; vector?: number[]; model?: string }[], status = "ready") {
	const id = `${name}-${tag}`;
	await database((sql) =>
		Effect.gen(function* () {
			yield* sql`insert into workspace_documents (id, workspace_id, name, media_type, size, text, status, added_by)
				values (${id}, ${workspaceId}, ${name}, 'text/markdown', 1, ${passages.map((passage) => passage.content).join("\n\n")}, ${status}, ${ana})`;
			const store = passageStore(sql);
			yield* store.replace(
				id,
				workspaceId,
				passages.map((passage, ordinal) => ({ ordinal, page: ordinal + 1, location: `${name} (page ${ordinal + 1})`, content: passage.content })),
			);
			for (const [ordinal, passage] of passages.entries()) yield* store.saveEmbeddings(passage.model ?? MODEL, [{ id: `${id}:${ordinal}`, vector: passage.vector ?? meaning(passage.content) }]);
		}),
	);
	return id;
}
const search = (workspaceId: string, query: string, documentIds: string[], owner = bob) =>
	runPromise(searchWorkspace({ owner, workspaceId, threadId: `thread-${tag}`, query, documentIds })).then((found) => found.map((excerpt) => excerpt.content));

describe.skipIf(!base)("workspace search", () => {
	const docs = { ward: "", stale: "", reading: "", other: "" };

	beforeAll(async () => {
		await database((sql) =>
			Effect.gen(function* () {
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				yield* sql`insert into users (id, name, email, role) values (${ana}, 'Ana', 'ana@example.invalid', 'user'), (${bob}, 'Bob', 'bob@example.invalid', 'user')`;
			}),
		);
		await runPromise(
			Effect.gen(function* () {
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
				// The team tables (teams/tables.ts): a person's access reads their teams' grants.
				yield* Invites.Invites.use((invites) => invites.migrate);
				yield* Teams.Teams.use((teams) => teams.migrate);
				yield* Settings.Settings.use((settings) => settings.migrate);
				yield* Credits.Credits.use((credits) => credits.migrate);
				const workspaces = yield* Workspaces.Workspaces;
				ids.ward = (yield* workspaces.create({ id: ana, email: "ana@example.invalid" }, { name: "Ward", description: "", instructions: "Be brief.", icon: null })).id;
				ids.other = (yield* workspaces.create({ id: ana, email: "ana@example.invalid" }, { name: "Other", description: "", instructions: "", icon: null })).id;
				yield* workspaces.setMember({ id: ana, email: "ana@example.invalid" }, ids.ward, bob, "ask");
			}),
		);
		docs.ward = await seed(ids.ward, "dosing", [
			// Words and meaning: "vancomycin" and "dose", and the dose topic.
			{ content: "Vancomycin dose: 15 mg/kg every 5 days." },
			// Meaning only: near the dose topic, without the question's words.
			{ content: "Antibiotic amounts for peritonitis.", vector: [0.9, 0.1, 0.01] },
			// Words only: "vancomycin", about another topic.
			{ content: "Vancomycin allergy is rare.", vector: [0.01, 0.01, 1] },
			// Neither.
			{ content: "Clean the catheter exit site." },
		]);
		// The same text, made by another model, in a document not ready, or in another workspace: never found.
		// The old model's vector has another width: a search that compared it would fail.
		docs.stale = await seed(ids.ward, "stale", [{ content: "Vancomycin dose from the old model.", vector: [1, 0.01, 0.01, 0.01, 0.01], model: "old/embedding" }]);
		docs.reading = await seed(ids.ward, "reading", [{ content: "Vancomycin dose still reading." }], "reading");
		docs.other = await seed(ids.other, "elsewhere", [{ content: "Vancomycin dose in another workspace." }]);
	});
	afterAll(async () => {
		await database((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`));
		await dispose();
		await openRouter.close();
	});

	it("puts a passage found by words and meaning first, then by meaning or words alone", async () => {
		const found = await search(ids.ward, "vancomycin dose", [docs.ward, docs.stale, docs.reading]);
		assert.deepStrictEqual(found, ["Vancomycin dose: 15 mg/kg every 5 days.", "Vancomycin allergy is rare.", "Antibiotic amounts for peritonitis.", "Clean the catheter exit site."]);
		// By meaning alone, when no word matches: "cefazolin" is a dose word to the fake model, and in no passage.
		assert.deepStrictEqual((await search(ids.ward, "cefazolin", [docs.ward])).slice(0, 2), ["Vancomycin dose: 15 mg/kg every 5 days.", "Antibiotic amounts for peritonitis."]);
		// By words alone, when the meaning is elsewhere.
		assert.strictEqual((await search(ids.ward, "allergy", [docs.ward]))[0], "Vancomycin allergy is rare.");
	});

	it("reads only the current model's passages of ready documents in this workspace", async () => {
		const everything = [docs.ward, docs.stale, docs.reading, docs.other];
		const found = await search(ids.ward, "vancomycin dose", everything);
		for (const text of ["old model", "still reading", "another workspace"]) assert.ok(!found.some((content) => content.includes(text)), text);
		// A person who can't use the other workspace finds nothing there, even with its document's id.
		assert.deepStrictEqual(await search(ids.other, "vancomycin dose", [docs.other], bob), []);
		assert.lengthOf(await search(ids.other, "vancomycin dose", [docs.other], ana), 1);
	});

	it("keeps each search's embedding in runs for the asker and the chat, and charges no one's credits", async () => {
		const credits = () => runPromise(Credits.Credits.use((service) => service.status(bob)));
		const before = await credits();
		await search(ids.ward, "exit site care", [docs.ward]);
		const rows = await database((sql) => sql<{ id: string; function_id: string; thread_id: string; cost: number }>`
			select id, function_id, thread_id, cost_usd::float8 as cost from runs where "user" = ${bob} order by created_at desc limit 1`);
		assert.deepStrictEqual([rows[0].function_id, rows[0].thread_id, rows[0].cost], ["workspace-search", `thread-${tag}`, EMBED_COST]);
		assert.match(rows[0].id, /^workspace-search:/);
		assert.deepStrictEqual((await credits()).used, before.used);

		// charged_runs leaves out every system call, and keeps a reply's.
		const row = (id: string, functionId: string) => ({
			id: `${id}-${tag}`,
			parentId: null,
			threadId: null,
			user: ana,
			functionId,
			model: "m",
			steps: 1,
			inputTokens: 1,
			outputTokens: 1,
			cachedTokens: 0,
			costUsd: 1,
			durationMs: 1,
			toolCalls: [],
			finishReason: "stop",
		});
		await runPromise(Runs.Runs.use((runs) => Effect.forEach([...Runs.SYSTEM_FUNCTION_IDS, "chat"], (functionId) => runs.insert(row(functionId, functionId)))));
		const charged = await database((sql) => sql<{ function_id: string }>`select function_id from charged_runs where "user" = ${ana}`);
		assert.deepStrictEqual(
			charged.map((each) => each.function_id),
			["chat"],
		);
		const usage = await runPromise(Runs.Runs.use((runs) => runs.usageReport({ user: ana })));
		// Ana's search in the other workspace is in the list too, and in no total.
		assert.deepStrictEqual([usage.runs.length, usage.totals.runs, usage.totals.cost_usd], [7, 1, 1]);
	});

	it("gives a turn the documents that fit whole, and searches the rest for the latest message", async () => {
		const threadId = `turn-${tag}`;
		const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
		await runPromise(Threads.Threads.use((threads) => threads.save(threadId, bob, [message("m1", "What is the vancomycin dose?")], ids.ward)));
		// The fake OpenRouter gives no models list, so the window is unknown: 256,000 characters. A long manual goes to search.
		const long = await seed(ids.ward, "long", [{ content: `Exit site care. ${"Wash your hands first. ".repeat(12_000)}` }]);
		const turn = Option.getOrThrow(await runPromise(workspaceTurn({ owner: bob, workspaceId: ids.ward, threadId, modelId: "test/model" })));
		assert.deepStrictEqual([turn.name, turn.instructions], ["Ward", "Be brief."]);
		assert.deepStrictEqual(
			turn.documents?.map((document) => document.name),
			["dosing", "stale"],
		);
		assert.deepStrictEqual(turn.searchDocumentIds, [long]);
		// The long manual's passage is about exit sites, not doses; but it is the only one searched.
		assert.match(turn.excerpts, /^<workspace_excerpts>\n\[1\] long \(page 1\)\nExit site care\./);
		// Someone who can't ask there gets nothing.
		assert.ok(Option.isNone(await runPromise(workspaceTurn({ owner: `nobody-${tag}`, workspaceId: ids.ward, threadId, modelId: "test/model" }))));
	});

	/** The next embedding call never ends. Gives when it came. */
	function hangEmbedding() {
		let came = () => {};
		const arrived = new Promise<void>((resolve) => (came = resolve));
		openRouter.gate = (kind) => (kind === "embedding" ? (came(), new Promise<void>(() => {})) : undefined);
		return arrived;
	}
	/** Runs `effect` on the test clock, and moves it by `duration` once the hung call came. */
	const afterHang = <A, E>(effect: Effect.Effect<A, E, Services>, duration: Duration.Input) =>
		runPromise(
			Effect.gen(function* () {
				const arrived = hangEmbedding();
				const fiber = yield* Effect.forkChild(effect);
				yield* Effect.promise(() => arrived);
				yield* TestClock.adjust(duration);
				return yield* Fiber.join(fiber);
			}).pipe(Effect.provide(TestClock.layer()), Effect.ensuring(Effect.sync(() => (openRouter.gate = undefined)))),
		);

	it("gives a turn its documents but no excerpts when the search does not end in its budget", async () => {
		const threadId = `turn-${tag}`;
		const turn = Option.getOrThrow(await afterHang(workspaceTurn({ owner: bob, workspaceId: ids.ward, threadId, modelId: "test/model" }), RETRIEVAL_BUDGET));
		assert.strictEqual(turn.excerpts, excerptsBlock([]));
		assert.deepStrictEqual(
			turn.documents?.map((document) => document.name),
			["dosing", "stale"],
		);
	});

	it("aborts an embedding call that does not end in time, with a typed error", async () => {
		const failed = await afterHang(Effect.flip(searchWorkspace({ owner: bob, workspaceId: ids.ward, threadId: `thread-${tag}`, query: "vancomycin", documentIds: [docs.ward] })), EMBED_TIMEOUT);
		assert.strictEqual(failed._tag, "EmbeddingTimedOut");
	});
});
