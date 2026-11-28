/**
 * Chats in a workspace (workflow/replies.ts): the first message binds the chat to a
 * workspace, it never changes after, and a person who lost access can read the chat but
 * not send in it, also when they lost it with a team. On a real Postgres (TEST_DATABASE_URL), in a schema of its own, which
 * the last test drops. Workflow's runtime is a fake that records each turn it starts.
 */
import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Hono } from "hono";
import type { WorkflowReadableStream } from "workflow/api";
import type { ChatTurn } from "../workflow/chat.ts";
import { jsonBody } from "../test-json.ts";
import { base, blockedBy, holdRows, USERS_TABLE, useTestSchema } from "./test-env.ts";

const tag = Math.random().toString(36).slice(2, 10);
const schema = `test_workspace_chats_${tag}`;
useTestSchema(schema);

const AppLayer = await import("../runtime/layer.ts");
const { route } = await import("../runtime/route.ts");
const { dispose } = await import("../runtime/runtime.ts");
const { threadResponse } = await import("../thread-cache.ts");
const Replies = await import("../workflow/replies.ts");
const WorkflowRuns = await import("../workflow/WorkflowRuns.ts");
const Threads = await import("../threads/Threads.ts");
const Workspaces = await import("./Workspaces.ts");
const Invites = await import("../people/Invites.ts");
const Teams = await import("../teams/Teams.ts");
const AdminEvents = await import("../admin/AdminEvents.ts");
const ThreadRuns = await import("../workflow/runs.ts");
const Runs = await import("../telemetry/Runs.ts");
const Settings = await import("../settings/Settings.ts");
const Credits = await import("../credits/Credits.ts");
const ApprovalUses = await import("../workflow/approval-uses.ts");
const PythonState = await import("../python/state.ts");
const Sandbox = await import("../python/pyodide.ts");

/** The turns Workflow was asked to start, in order. */
const turns: ChatTurn[] = [];
const emptyStream = () => Object.assign(new ReadableStream<ModelCallStreamPart>({ start: (controller) => controller.close() }), { getTailIndex: async () => -1 }) as WorkflowReadableStream<ModelCallStreamPart>;
const fakeWorkflow = Layer.succeed(
	WorkflowRuns.WorkflowRuns,
	WorkflowRuns.WorkflowRuns.of({
		start: (turn) =>
			Effect.sync(() => {
				turns.push(turn);
				return `wrun_01KCHAT${tag.toUpperCase().padEnd(8, "0")}${String(turns.length).padStart(10, "0")}`;
			}),
		status: () => Effect.succeed("completed"),
		cancel: () => Effect.void,
		readable: () => Effect.sync(emptyStream),
		endStream: () => Effect.void,
	}),
);
const onFakeWorkflow = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, Layer.fresh(Replies.layer).pipe(Layer.provide(fakeWorkflow)));

const ana = `ana-${tag}`;
const bob = `bob-${tag}`;
const dan = `dan-${tag}`;
const actor = (id: string) => ({ id, email: `${id}@example.invalid` });
const message = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

/** GET /api/threads/:id as the app answers it (thread-cache.ts). */
const reader = new Hono().get("/:owner/:id", (c) => route(c, threadResponse(c, c.req.param("id"), c.req.param("owner"))));
type ThreadAnswer = { messages: UIMessage[]; workspaceId?: string };
const read = (owner: string, threadId: string) =>
	Effect.promise(async (): Promise<ThreadAnswer> => {
		const response = await reader.request(`/${owner}/${threadId}`);
		return jsonBody<ThreadAnswer>(response);
	});

/** Ana's private workspace, shared with Bob, and an organisation workspace. */
const ids = { notes: "", handbook: "" };

describe.skipIf(!base)("chats in a workspace", () => {
	afterAll(() =>
		Effect.runPromise(PgClient.PgClient.use((sql) => sql.unsafe(`drop schema if exists ${schema} cascade`)).pipe(Effect.provide(AppLayer.layer))).then(() => dispose()),
	);

	it.layer(AppLayer.layer, { excludeTestServices: true })((it) => {
		it.effect("makes the tables, the people and the workspaces", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql.unsafe(`create schema if not exists ${schema}`);
				yield* sql.unsafe(USERS_TABLE);
				yield* sql`insert into users (id, name, email, role) values (${ana}, 'Ana', ${`${ana}@example.invalid`}, 'admin'), (${bob}, 'Bob', ${`${bob}@example.invalid`}, 'user'), (${dan}, 'Dan', ${`${dan}@example.invalid`}, 'user')`;
				yield* Threads.Threads.use((threads) => threads.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				// Before Workspaces, as at start-up: a document's log references `runs`.
				yield* Runs.Runs.use((runs) => runs.migrate);
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.migrate);
				// The team tables (teams/tables.ts): a person's access reads their teams' grants.
				yield* Invites.Invites.use((invites) => invites.migrate);
				yield* Teams.Teams.use((teams) => teams.migrate);
				yield* ThreadRuns.ThreadRuns.use((runs) => runs.migrate);
				yield* Settings.Settings.use((settings) => settings.migrate);
				yield* Credits.Credits.use((credits) => credits.migrate);
				yield* ApprovalUses.ApprovalUses.use((uses) => uses.migrate);
				yield* PythonState.PythonState.use((states) => states.migrate);
				yield* Sandbox.Sandbox.use((sandbox) => sandbox.turnOff);
				const workspaces = yield* Workspaces.Workspaces;
				ids.notes = (yield* workspaces.create(actor(ana), { name: "Notes", description: "", instructions: "Answer in French.", icon: null })).id;
				ids.handbook = (yield* workspaces.create(actor(ana), { name: "Handbook", description: "", instructions: "", icon: null })).id;
				yield* workspaces.setOrgAccess(actor(ana), ids.handbook, "ask");
				yield* workspaces.setMember(actor(ana), ids.notes, bob, "ask");
			}),
		);

		it.effect("binds a new chat to the workspace its first message names, and puts it in the turn", () =>
			Effect.gen(function* () {
				const threadId = `chat-a-${tag}`;
				const replies = yield* Replies.Replies;
				const threads = yield* Threads.Threads;
				yield* replies.start({ threadId, owner: bob, messages: [message("m1", "Bonjour")], workspaceId: ids.notes });
				assert.strictEqual(turns.at(-1)?.workspaceId, ids.notes);
				assert.deepStrictEqual(yield* threads.workspaceOf(threadId), Option.some(ids.notes));
				const listed = (yield* threads.list(bob)).find((thread) => thread.id === threadId);
				assert.strictEqual(listed?.workspaceId, ids.notes);
				const instructions = yield* Workspaces.Workspaces.use((workspaces) => workspaces.instructionsFor(bob, ids.notes));
				assert.deepStrictEqual(instructions, Option.some({ name: "Notes", instructions: "Answer in French." }));
			}).pipe(onFakeWorkflow),
		);

		it.effect("two first messages at once both use the workspace the chat was saved with", () =>
			Effect.gen(function* () {
				const threadId = `chat-race-${tag}`;
				const replies = yield* Replies.Replies;
				const before = turns.length;
				yield* Effect.all(
					[ids.notes, ids.handbook].map((workspaceId) => replies.start({ threadId, owner: bob, messages: [message("m1", "Bonjour")], workspaceId })),
					{ concurrency: "unbounded" },
				);
				const saved = Option.getOrUndefined(yield* Threads.Threads.use((threads) => threads.workspaceOf(threadId)));
				const started = turns.slice(before).filter((turn) => turn.threadId === threadId);
				assert.lengthOf(started, 2);
				for (const turn of started) assert.strictEqual(turn.workspaceId, saved);
			}).pipe(onFakeWorkflow),
		);

		it.effect("a later message cannot change the chat's workspace, or add one", () =>
			Effect.gen(function* () {
				const replies = yield* Replies.Replies;
				const threads = yield* Threads.Threads;
				const bound = `chat-a-${tag}`;
				yield* replies.start({ threadId: bound, owner: bob, messages: [message("m1", "Bonjour"), message("m2", "Encore")], workspaceId: ids.handbook });
				assert.strictEqual(turns.at(-1)?.workspaceId, ids.notes);
				assert.deepStrictEqual(yield* threads.workspaceOf(bound), Option.some(ids.notes));

				const plain = `chat-plain-${tag}`;
				yield* replies.start({ threadId: plain, owner: bob, messages: [message("m1", "Hi")] });
				yield* replies.start({ threadId: plain, owner: bob, messages: [message("m1", "Hi"), message("m2", "Now in Notes")], workspaceId: ids.notes });
				assert.isUndefined(turns.at(-1)?.workspaceId);
				assert.deepStrictEqual(yield* threads.workspaceOf(plain), Option.none());
			}).pipe(onFakeWorkflow),
		);

		it.effect("lists a person's chats in a workspace before the limit, so newer chats elsewhere do not hide them", () =>
			Effect.gen(function* () {
				const threads = yield* Threads.Threads;
				const inNotes = `chat-a-${tag}`;
				// Ana's chat in the same workspace is hers: never in Bob's list.
				yield* Replies.Replies.use((replies) => replies.start({ threadId: `chat-ana-${tag}`, owner: ana, messages: [message("m1", "Mine")], workspaceId: ids.notes }));
				yield* Effect.forEach(Array.from({ length: 201 }, (_, index) => index), (index) => threads.save(`chat-newer-${index}-${tag}`, bob, [message("m1", `Newer ${index}`)]), { discard: true });
				assert.notInclude((yield* threads.list(bob)).map((thread) => thread.id), inNotes);
				const listed = yield* threads.list(bob, ids.notes);
				assert.include(
					listed.map((thread) => thread.id),
					inNotes,
				);
				assert.notInclude(
					listed.map((thread) => thread.id),
					`chat-ana-${tag}`,
				);
				assert.ok(listed.every((thread) => thread.workspaceId === ids.notes));
			}).pipe(onFakeWorkflow),
		);

		it.effect("a new chat in a workspace the person can't use is not found, and nothing is saved", () =>
			Effect.gen(function* () {
				const threadId = `chat-dan-${tag}`;
				const started = turns.length;
				const refused = yield* Effect.flip(Replies.Replies.use((replies) => replies.start({ threadId, owner: dan, messages: [message("m1", "Let me in")], workspaceId: ids.notes })));
				assert.strictEqual(refused._tag, "WorkspaceNotFound");
				assert.strictEqual(turns.length, started);
				assert.deepStrictEqual(yield* Threads.Threads.use((threads) => threads.owner(threadId)), Option.none());
				// An organisation workspace is everyone's to ask in.
				yield* Replies.Replies.use((replies) => replies.start({ threadId, owner: dan, messages: [message("m1", "Hello")], workspaceId: ids.handbook }));
				assert.strictEqual(turns.at(-1)?.workspaceId, ids.handbook);
			}).pipe(onFakeWorkflow),
		);

		it.effect("a member who was removed can read their chat, but not send in it", () =>
			Effect.gen(function* () {
				const threadId = `chat-a-${tag}`;
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.removeMember(actor(ana), ids.notes, bob));
				const started = turns.length;
				const refused = yield* Effect.flip(Replies.Replies.use((replies) => replies.start({ threadId, owner: bob, messages: [message("m1", "Bonjour"), message("m3", "Still here?")] })));
				assert.strictEqual(refused._tag, "WorkspaceAccessLost");
				assert.include(refused.message, "You can read this chat, but not send in it.");
				assert.strictEqual(turns.length, started);
				const thread = yield* read(bob, threadId);
				assert.deepStrictEqual(
					thread.messages.map((each) => each.id),
					["m1", "m2"],
				);
				assert.strictEqual(thread.workspaceId, ids.notes);
				// The owner of the workspace sees nothing of Bob's chat.
				assert.deepStrictEqual((yield* read(ana, threadId)).messages, []);
				const detail = yield* Workspaces.Workspaces.use((workspaces) => workspaces.get(ana, ids.notes));
				assert.notInclude(JSON.stringify(detail), threadId);
			}).pipe(onFakeWorkflow),
		);

		it.effect("a person removed from a team can read their chat in the team's workspace, but not send in it; an archived team too", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const workspaces = yield* Workspaces.Workspaces;
				const teams = yield* Teams.Teams;
				const replies = yield* Replies.Replies;
				const shared = (yield* workspaces.create(actor(ana), { name: "Team notes", description: "", instructions: "", icon: null })).id;
				const team = (yield* teams.create(actor(ana), { name: `Chat team ${tag}`, description: "", adminUserId: ana })).id;
				yield* teams.setMember(actor(ana), team, dan, "member");
				yield* workspaces.setTeam(actor(ana), shared, team, "ask");

				const threadId = `chat-team-${tag}`;
				yield* replies.start({ threadId, owner: dan, messages: [message("m1", "Hi team")], workspaceId: shared });
				assert.strictEqual(turns.at(-1)?.workspaceId, shared);
				const lost = () => Effect.flip(replies.start({ threadId, owner: dan, messages: [message("m1", "Hi team"), message("m2", "Still here?")] }));

				yield* teams.removeMember(actor(ana), team, dan);
				const started = turns.length;
				const refused = yield* lost();
				assert.strictEqual(refused._tag, "WorkspaceAccessLost");
				assert.strictEqual(turns.length, started);
				assert.deepStrictEqual(
					(yield* read(dan, threadId)).messages.map((each) => each.id),
					["m1"],
				);

				yield* teams.setMember(actor(ana), team, dan, "member");
				yield* sql`update teams set archived_at = now() where id = ${team}`;
				assert.strictEqual((yield* lost())._tag, "WorkspaceAccessLost", "an archived team gives nothing");
				assert.strictEqual((yield* read(dan, threadId)).workspaceId, shared);
			}).pipe(onFakeWorkflow),
		);

		it.effect("a first message that races the workspace's delete is not saved into the workspace", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const workspaces = yield* Workspaces.Workspaces;
				const replies = yield* Replies.Replies;
				const racing = (yield* workspaces.create(actor(ana), { name: "Racing", description: "", instructions: "", icon: null })).id;
				yield* workspaces.setOrgAccess(actor(ana), racing, "ask");
				// A chat already in it, whose row the test holds: the delete stops there, with the workspace taken.
				const held = `chat-held-${tag}`;
				yield* replies.start({ threadId: held, owner: bob, messages: [message("m1", "Hi")], workspaceId: racing });
				const hold = yield* holdRows(sql, sql`select id from threads where id = ${held} for update`);
				const deleting = yield* Effect.forkChild(workspaces.remove(actor(ana), racing));
				const deleter = yield* blockedBy(sql, hold.pid);

				const threadId = `chat-racing-${tag}`;
				const sending = yield* Effect.forkChild(Effect.flip(replies.start({ threadId, owner: dan, messages: [message("m1", "Am I in?")], workspaceId: racing })));
				// The first message waits for the delete; one that does not wait is saved at once.
				yield* Effect.raceFirst(Effect.asVoid(Fiber.await(sending)), Effect.asVoid(blockedBy(sql, deleter)));
				yield* hold.release;
				yield* Fiber.join(deleting);
				const refused = yield* Fiber.join(sending);
				assert.strictEqual(refused._tag, "WorkspaceNotFound");
				assert.deepStrictEqual(yield* Threads.Threads.use((threads) => threads.owner(threadId)), Option.none());
				assert.deepStrictEqual(yield* Threads.Threads.use((threads) => threads.workspaceOf(held)), Option.none());
			}).pipe(onFakeWorkflow),
		);

		it.effect("a deleted workspace lets its chats go, and they can be used again", () =>
			Effect.gen(function* () {
				const threadId = `chat-a-${tag}`;
				yield* Workspaces.Workspaces.use((workspaces) => workspaces.remove(actor(ana), ids.notes));
				assert.deepStrictEqual(yield* Threads.Threads.use((threads) => threads.workspaceOf(threadId)), Option.none());
				assert.isUndefined((yield* read(bob, threadId)).workspaceId);
				yield* Replies.Replies.use((replies) => replies.start({ threadId, owner: bob, messages: [message("m1", "Bonjour"), message("m3", "Still here?")] }));
				assert.isUndefined(turns.at(-1)?.workspaceId);
			}).pipe(onFakeWorkflow),
		);
	});
});
