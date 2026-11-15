/**
 * Checks for one compaction run (compaction/compaction.ts) with fake storage and a fake
 * summarizer: what is summarized and saved, a step retried after its save, a run that was
 * stopped or replaced, a summary that fails, and a chat that is long because of its files.
 * No database, no network:
 *   npx tsx server/compaction-flow.check.ts
 */
import assert from "node:assert/strict";
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { runCompaction, type CompactionDeps, type CompactionState, type CompactRequest } from "./compaction/compaction.ts";
import { addConnectorNote } from "./workflow/connector-messages.ts";
import { currentTurnStart, type Summary } from "./compaction/summary.ts";

let n = 0;
const id = () => `m${++n}`;
const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");
const user = (text: string, ...parts: UIMessage["parts"]): UIMessage => ({ id: id(), role: "user", parts: [{ type: "text", text }, ...parts] });
const reply = (text: string): UIMessage => ({ id: id(), role: "assistant", parts: [{ type: "text", text }] });
/** Four long turns, then the current one: about 7,500 tokens a long message. */
const longThread = () => [user(`ONE ${words(5_000)}`), reply("a"), user(`TWO ${words(5_000)}`), reply("b"), user(`THREE ${words(5_000)}`), reply("c"), user(`FOUR ${words(5_000)}`), reply("d"), user("CURRENT question")];

/** The fake world one run sees, and what it did. */
class World {
	saved: { summary: Summary; model: string } | undefined;
	states: CompactionState[] = [];
	summarized: UIMessage[][] = [];
	logs: string[] = [];
	supersededAt = Number.POSITIVE_INFINITY;
	supersededChecks = 0;
	fail = false;
	kept: (string | undefined)[] = [];

	constructor(public thread: UIMessage[]) {}

	deps(): CompactionDeps<Error> {
		return {
			loadThread: () => Effect.sync(() => this.thread),
			loadSummary: () => Effect.sync(() => Option.fromUndefinedOr(this.saved?.summary)),
			saveSummary: (_id, _thread, summary, model) => Effect.sync(() => void (this.saved = { summary, model })),
			superseded: () => Effect.sync(() => ++this.supersededChecks >= this.supersededAt),
			writeSummary: ({ messages }) =>
				Effect.suspend(() => {
					this.summarized.push(messages);
					if (this.fail) return Effect.fail(new Error("summarizer down"));
					return Effect.succeed({ text: "SUMMARY", model: "deepseek/deepseek-v4.1-flash" });
				}),
			// As thread-messages.ts builds them: the SDK's own conversion, and the <connectors> note with the latest message.
			modelMessages: (thread, { connectors, keepReasoningOf }) =>
				Effect.promise(async () => (this.kept.push(keepReasoningOf), addConnectorNote(await convertToModelMessages(thread), connectors))),
			status: (state) => Effect.sync(() => void this.states.push(state)),
			log: (message) => Effect.sync(() => void this.logs.push(message)),
		};
	}
}

const request = (overrides: Partial<CompactRequest> = {}): CompactRequest => ({
	threadId: "t1",
	owner: "p1",
	runId: "wrun_02",
	modelId: "z-ai/glm-5.3",
	recalled: "",
	connectors: "",
	skills: [],
	ratio: 1,
	window: 40_000,
	envelope: 2_000,
	mode: "start",
	...overrides,
});
const run = (world: World, overrides: Partial<CompactRequest> = {}, lastAttempt = false) => Effect.runPromise(runCompaction(request(overrides), world.deps(), lastAttempt));
const textOf = (messages: ModelMessage[]) => JSON.stringify(messages);

// --- A compaction: the summarizer reads up to the current turn, not into it; the summary saved says what it read.
{
	const world = new World(longThread());
	const result = await run(world);
	assert.equal(result.kind, "compacted");
	assert.equal(world.summarized.length, 1);
	const read = JSON.stringify(world.summarized[0]);
	assert.ok(read.includes("ONE") && !read.includes("CURRENT question"), "the current turn stays out of the summary");
	assert.equal(world.saved?.summary.reads, 8, "it read up to the current turn");
	assert.ok(world.saved && world.saved.summary.covers <= 8);
	assert.deepEqual(world.states.map((state) => state.state), ["running", "done"]);
	assert.equal(world.states.at(-1)?.through, world.thread[world.saved!.summary.covers - 1].id);
	assert.ok(result.kind === "compacted" && textOf(result.messages).includes("SUMMARY") && textOf(result.messages).includes("CURRENT question"));
}

// --- A reply carried on after an approval keeps its reasoning in the messages built with the summary.
{
	const world = new World(longThread());
	await run(world, { keepReasoningOf: "d" });
	assert.deepEqual(world.kept, ["d"]);
}

// --- A step retried after its save: the saved summary is the result, and nothing is summarized again.
{
	const world = new World(longThread());
	await run(world);
	const first = world.saved;
	world.states = [];
	const retried = await run(world);
	assert.equal(retried.kind, "compacted");
	assert.equal(world.summarized.length, 1, "no second summary");
	assert.equal(world.saved, first);
	assert.deepEqual(world.states, [{ state: "done", through: world.thread[first!.summary.covers - 1].id }]);
	assert.ok(retried.kind === "compacted" && textOf(retried.messages).includes("SUMMARY"));
}

// --- A run that was stopped or replaced before the summary: it summarizes nothing and saves nothing.
{
	const world = new World(longThread());
	world.supersededAt = 1;
	assert.equal((await run(world)).kind, "unchanged");
	assert.equal(world.summarized.length, 0);
	assert.equal(world.saved, undefined);
}
// Stopped while the summary was written: the summary is not saved over a newer run's.
{
	const world = new World(longThread());
	world.supersededAt = 2;
	const result = await run(world);
	assert.equal(result.kind, "compacted");
	assert.equal(world.summarized.length, 1);
	assert.equal(world.saved, undefined);
}

// --- A summary that fails: the step tries again; on its last attempt the reply goes on without the old messages.
{
	const world = new World(longThread());
	world.fail = true;
	await assert.rejects(run(world), /summarizer down/);
	// Long instructions leave room for the current turn only, so the ladder covers up to it.
	const result = await run(world, { envelope: 15_000 }, true);
	assert.equal(result.kind, "left-out");
	assert.equal(world.saved, undefined, "nothing is saved, so the next reply tries again");
	assert.equal(world.states.at(-1)?.state, "failed");
	assert.ok(world.logs[0].startsWith("reply degraded: summary"));
	// The note counts the messages the reply really leaves out, also when the ladder keeps only the current turn.
	const text = result.kind === "left-out" ? textOf(result.messages) : "";
	const count = Number(text.match(/\[(\d+) earlier messages/)?.[1]);
	const kept = result.kind === "left-out" ? result.messages.length - 1 : 0;
	assert.equal(count, 8, "all eight messages before the current turn");
	assert.equal(count + kept, world.thread.length, `the note's ${count} and the ${kept} messages kept are the whole thread`);
}

// --- Between steps: everything before the current turn is summarized, and only the summary message comes back.
{
	const world = new World(longThread());
	const result = await run(world, { mode: "turn", turn: { text: 100, media: 0 } });
	assert.equal(result.kind, "compacted");
	assert.equal(world.saved?.summary.covers, 8);
	assert.ok(result.kind === "compacted" && result.messages.length === 1 && textOf(result.messages).includes("SUMMARY"));
	// A second time in another reply: the same summary stands for the same messages.
	assert.equal((await run(world, { mode: "turn", turn: { text: 100, media: 0 } })).kind, "compacted");
	assert.equal(world.summarized.length, 1);
}

// --- A chat that is long because of its files: little text to fold is not worth a summary.
{
	const pdf = { type: "file" as const, mediaType: "application/pdf", url: `data:application/pdf;base64,${"A".repeat(4_000_000)}` };
	const world = new World([user("Read this", pdf), reply("ok"), user("And this?"), reply("yes"), user("CURRENT question")]);
	assert.equal((await run(world)).kind, "unchanged");
	assert.equal(world.summarized.length, 0);
}
// Files never refuse a message: a huge PDF in the current turn still fits, since its estimate is a guess.
{
	const pdf = { type: "file" as const, mediaType: "application/pdf", url: `data:application/pdf;base64,${"A".repeat(8_000_000)}` };
	const world = new World([...longThread().slice(0, 8), user("CURRENT question", pdf)]);
	const result = await run(world);
	assert.equal(result.kind, "compacted", "not over-limit");
	assert.equal(world.saved?.summary.keepFiles, true, "files are not dropped for their estimate");
}

// --- The <connectors> note is per-turn context, as memory's is: never summarized, sent once, with the latest message.
{
	const note = "<connectors>\nshop: Shop, 2 tools\n</connectors>";
	const count = (messages: ModelMessage[]) => textOf(messages).split("<connectors>").length - 1;
	const world = new World(longThread());
	const result = await run(world, { connectors: note });
	assert.equal(result.kind, "compacted");
	assert.ok(!JSON.stringify(world.summarized[0]).includes("<connectors>"), "the summarizer never reads the note");
	assert.ok(result.kind === "compacted" && count(result.messages) === 1, "the note is sent once");
	const last = result.kind === "compacted" ? result.messages.findLast((message) => message.role === "user") : undefined;
	assert.ok(textOf(last ? [last] : []).includes("<connectors>") && textOf(last ? [last] : []).includes("CURRENT question"), "on the current turn's message, not the summary's");

	// Between steps, the current turn is already in the prompt with its note: the summary message carries none.
	const between = await run(new World(longThread()), { connectors: note, mode: "turn", turn: { text: 100, media: 0 } });
	assert.ok(between.kind === "compacted" && count(between.messages) === 0, "not counted twice between steps");
}

// --- A connector_call waiting for approval, or approved and run, is in the current turn, and never summarized away from its turn.
{
	const call = { type: "tool-connector_call", toolCallId: "call_1", input: { tool: "shop__add_note", input: { order: "A1", note: "Gift wrap" } } };
	const waiting = { ...call, state: "approval-requested", approval: { id: "approval_1" } } as unknown as UIMessage["parts"][number];
	const answered = { ...call, state: "approval-responded", approval: { id: "approval_1", approved: true } } as unknown as UIMessage["parts"][number];
	for (const part of [waiting, answered]) {
		const thread = [...longThread(), { id: id(), role: "assistant" as const, parts: [part] }];
		for (const mode of ["start", "turn"] as const) {
			const world = new World(thread);
			const result = await run(world, { mode, turn: mode === "turn" ? { text: 200, media: 0 } : undefined });
			assert.equal(result.kind, "compacted", mode);
			assert.ok(!JSON.stringify(world.summarized[0]).includes("call_1"), `${mode}: the call is not summarized`);
			assert.ok((world.saved?.summary.covers ?? 0) <= currentTurnStart(thread), `${mode}: the summary ends before the current turn`);
			// From the start, the call and its approval stay together in the messages; between steps they are already in the prompt.
			if (mode === "start") assert.ok(result.kind === "compacted" && textOf(result.messages).includes("call_1") && textOf(result.messages).includes("approval_1"));
		}
	}
}

console.log("compaction flow checks passed");
