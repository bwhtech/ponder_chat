/**
 * Checks for tracing (server/tracing/): no span leaves Ponder with content in it, and a
 * reply's trace has the same ids in every process. No database, no network: the spans
 * go to memory, and the one HTTP request goes to a server on this machine.
 * Run: npx tsx server/tracing.check.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenTelemetry } from "@ai-sdk/otel";
import { context, SpanKind, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace";
import { registerTelemetry, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { withPeer } from "./tracing/http.ts";
import { cleanSpan, withoutConnector } from "./tracing/privacy.ts";
import { endReplyTrace, linkToReply, recordReplySpan, replyIds, runStartTime, withReplyTrace } from "./tracing/reply-trace.ts";
import * as Logger from "./tracing/Logger.ts";
import { SQL_STATEMENT_SPAN, startTracing, tracesUrl, withoutContent } from "./tracing/setup.ts";
import { tracingState } from "./tracing/state.ts";
import * as Tracing from "./tracing/Tracing.ts";

let failed = 0;

async function check(name: string, body: () => Promise<void>) {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
	}
}

/** Text that stands for content: a message, a prompt, a tool's input or output, a file name, an address. */
const MARKER = "mk-7f3a9c-private";
const RUN_ID = "wrun_01M7AAXEME3MDRQZPA53SJG1W7";

/** Everything a span would send: its name, attributes, events, status and links. */
const sent = (spans: ReadableSpan[]) =>
	JSON.stringify(
		spans.map((each) => ({ name: each.name, attributes: each.attributes, events: each.events, status: each.status, links: each.links, resource: each.resource.attributes })),
	);

/** A model that calls the `lookup` tool once, then answers. The prompt, the call and the answer all hold MARKER. */
function model() {
	const usage = { inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: undefined }, outputTokens: { total: 9, text: 9, reasoning: undefined } };
	const finish = (unified: "stop" | "tool-calls") => ({ unified, raw: unified });
	let calls = 0;
	return new MockLanguageModelV4({
		provider: "openrouter",
		modelId: "test/model",
		doStream: async () => {
			calls++;
			const parts =
				calls === 1
					? [
							{ type: "stream-start" as const, warnings: [] },
							{ type: "tool-call" as const, toolCallId: "call-1", toolName: "lookup", input: JSON.stringify({ query: MARKER }) },
							{ type: "finish" as const, finishReason: finish("tool-calls"), usage },
						]
					: [
							{ type: "stream-start" as const, warnings: [] },
							{ type: "text-start" as const, id: "t" },
							{ type: "text-delta" as const, id: "t", delta: `The answer is ${MARKER}.` },
							{ type: "text-end" as const, id: "t" },
							{ type: "finish" as const, finishReason: finish("stop"), usage },
						];
			return { stream: new ReadableStream({ start: (controller) => (parts.forEach((part) => controller.enqueue(part)), controller.close()) }) };
		},
	});
}

/** A model that answers at once, for the call inside an Effect span. */
function answeringModel() {
	const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } };
	const parts = [
		{ type: "stream-start" as const, warnings: [] },
		{ type: "text-start" as const, id: "t" },
		{ type: "text-delta" as const, id: "t", delta: `Effect says ${MARKER}.` },
		{ type: "text-end" as const, id: "t" },
		{ type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
	];
	return new MockLanguageModelV4({
		provider: "openrouter",
		modelId: "test/effect",
		doStream: async () => ({ stream: new ReadableStream({ start: (controller) => (parts.forEach((part) => controller.enqueue(part)), controller.close()) }) }),
	});
}

class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {}) {
	override get message() {
		return `the check failed with ${MARKER}`;
	}
}

const tools = {
	lookup: tool({ description: "Looks something up.", inputSchema: z.object({ query: z.string() }), execute: async ({ query }) => `Found ${query} and ${MARKER}.` }),
};

// --- The allowlist, on its own.

await check("a span loses every attribute, event, status message and name that is not on the allowlist", async () => {
	const fake = {
		name: `GET https://x.invalid/${MARKER}?q=${MARKER}`,
		kind: SpanKind.INTERNAL,
		spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: TraceFlags.SAMPLED }),
		startTime: [0, 0],
		endTime: [1, 0],
		duration: [1, 0],
		ended: true,
		status: { code: SpanStatusCode.ERROR, message: `could not read https://x.invalid/${MARKER}` },
		attributes: {
			"gen_ai.input.messages": `[{"role":"user","content":"${MARKER}"}]`,
			"gen_ai.output.messages": MARKER,
			"gen_ai.system_instructions": MARKER,
			"gen_ai.tool.call.arguments": MARKER,
			"gen_ai.tool.call.result": MARKER,
			"ai.prompt": MARKER,
			"ai.response.text": MARKER,
			"ai.toolCall.args": MARKER,
			"step.error.message": MARKER,
			"workflow.error.message": MARKER,
			"workflow.hook.token": MARKER,
			"url.full": `https://x.invalid/${MARKER}?q=${MARKER}`,
			"url.path": MARKER,
			"db.statement": MARKER,
			"ponder.file_name": MARKER,
			"gen_ai.usage.input_tokens": 120,
			"gen_ai.request.model": "test/model",
			"workflow.run.id": RUN_ID,
			"workflow.queue.overhead_ms": 12,
			// Keys that are kept, with values that do not look like a name.
			"gen_ai.response.id": `id of ${MARKER}`,
			"error.type": `${MARKER} could not be read`,
			"messaging.destination.name": `queue\n${MARKER}`,
		},
		links: [{ context: { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 }, attributes: { note: MARKER } }],
		events: [
			{ name: "exception", time: [0, 0], attributes: { "exception.type": "TypeError", "exception.message": MARKER, "exception.stacktrace": MARKER } },
			{ name: "gen_ai.content.prompt", time: [0, 0], attributes: { "gen_ai.prompt": MARKER } },
		],
		resource: { attributes: {} },
		instrumentationScope: { name: "test" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	} as unknown as ReadableSpan;
	assert.ok(sent([fake]).includes(MARKER), "the check's span holds the marker before it is cleaned");

	const clean = cleanSpan(fake);
	assert.ok(!sent([clean]).includes(MARKER), sent([clean]));
	assert.equal(clean.name, "span");
	assert.deepEqual(clean.attributes, { "gen_ai.usage.input_tokens": 120, "gen_ai.request.model": "test/model", "workflow.run.id": RUN_ID, "workflow.queue.overhead_ms": 12 });
	assert.deepEqual(clean.events.map((event) => [event.name, event.attributes]), [["exception", { "exception.type": "TypeError" }]]);
	assert.deepEqual(clean.status, { code: SpanStatusCode.ERROR });
	assert.equal(clean.spanContext().spanId, "b".repeat(16));
	assert.equal(cleanSpan({ ...fake, name: "execute_tool web_fetch" } as ReadableSpan).name, "execute_tool web_fetch");
});

await check("a connector's tools are named without the connector's name, which the person chose", async () => {
	const toolSpan = {
		name: "execute_tool my_bank__list_payments",
		status: { code: SpanStatusCode.OK },
		attributes: {
			"gen_ai.tool.name": "my_bank__list_payments",
			"ai.toolCall.name": "my_bank__list_payments",
			// Some providers build a call's id from the tool's name.
			"gen_ai.tool.call.id": "functions.my_bank__list_payments:0",
			"ai.toolCall.id": "tool_0_my_bank__list_payments",
		},
		links: [],
		events: [],
	};
	const clean = cleanSpan(toolSpan as unknown as ReadableSpan);
	assert.equal(clean.name, "execute_tool connector__list_payments");
	assert.equal(clean.attributes["gen_ai.tool.name"], "connector__list_payments");
	assert.equal(clean.attributes["ai.toolCall.name"], "connector__list_payments");
	assert.equal(clean.attributes["gen_ai.tool.call.id"], "functions.connector__list_payments:0");
	assert.equal(clean.attributes["ai.toolCall.id"], "connector__list_payments");
	assert.ok(!JSON.stringify(clean.attributes).includes("my_bank"));
	// An id with no connector in it stays as it was.
	assert.equal(withoutConnector("call_gen-fake-1794569482045_0"), "call_gen-fake-1794569482045_0");
	// Ponder's own tools have no connector part.
	assert.equal(withoutConnector("web_fetch"), "web_fetch");
	assert.equal(withoutConnector("run_python"), "run_python");
});

await check("an endpoint without http:// or https:// is refused before tracing starts", async () => {
	for (const endpoint of ["127.0.0.1:4318", "localhost:4318", "ftp://127.0.0.1:4318", "not an address", "http://", "https:", "http:/"]) {
		assert.throws(() => tracesUrl(endpoint), /OTEL_EXPORTER_OTLP_ENDPOINT/, endpoint);
		await assert.rejects(startTracing(endpoint), /OTEL_EXPORTER_OTLP_ENDPOINT/, endpoint);
	}
	assert.equal(tracingState(), undefined, "a refused endpoint left tracing half set up");
	assert.equal(tracesUrl("http://127.0.0.1:4318/").href, "http://127.0.0.1:4318/v1/traces");
	assert.equal(tracesUrl("https://otel.example.org/base").href, "https://otel.example.org/base/v1/traces");
});

await check("the AI SDK records no inputs or outputs through Ponder's integration, even when a call asks it to", async () => {
	// A provider of its own, with no allowlist, so this sees what the integration itself records.
	const record = async (wrap: boolean) => {
		const exporter = new InMemorySpanExporter();
		const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
		const integration = new OpenTelemetry({ tracer: provider.getTracer("ai"), usage: true });
		await streamText({
			model: model(),
			prompt: `Tell me about ${MARKER}`,
			tools,
			stopWhen: stepCountIs(3),
			telemetry: { integrations: [wrap ? withoutContent(integration) : integration], recordInputs: true, recordOutputs: true },
		}).consumeStream();
		return exporter.getFinishedSpans();
	};
	// Without Ponder's wrapper the same call records the prompt, the tool's input and output, and the answer.
	assert.ok(sent(await record(false)).includes(MARKER), "the integration recorded no content without the wrapper: this check would prove nothing");
	const spans = await record(true);
	assert.ok(spans.some((each) => each.name.startsWith("chat ")), spans.map((each) => each.name).join(", "));
	assert.ok(!sent(spans).includes(MARKER), sent(spans));
});

// --- The whole pipeline: Ponder's provider, the AI SDK, HTTP, the root span, the allowlist.

// A local server that is both a page and "OpenRouter" (OPENROUTER_BASE_URL), as in the e2e tests.
const server = createServer((request, response) => {
	response.statusCode = request.url?.includes("missing") ? 404 : 200;
	response.end(`page with ${MARKER}`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.OPENROUTER_BASE_URL = `${address}/api`;

const exported = new InMemorySpanExporter();
const tracing = await startTracing("http://127.0.0.1:9", exported);
assert.ok(tracing);
registerTelemetry(tracing.integration);

// Effect code, on the server's tracer and logger (server/runtime/layer.ts gives the app the same).
const effects = ManagedRuntime.make(Layer.mergeAll(Tracing.layer, Logger.layer));
/** What a log line wrote to stderr, where console.warn and console.error go. */
async function stderrOf(work: () => Promise<unknown>) {
	const write = process.stderr.write;
	let written = "";
	process.stderr.write = ((chunk: string | Uint8Array) => ((written += String(chunk)), true)) as typeof process.stderr.write;
	try {
		await work();
	} finally {
		process.stderr.write = write;
	}
	return written;
}
let effectLog = "";
/** Ponder's own span around some work, as the services make it (Effect.fn), with its attributes. */
const span = (name: string, attributes: Tracing.SpanAttributes, work: () => Promise<unknown>) =>
	effects.runPromise(
		Effect.gen(function* () {
			yield* Tracing.annotate(attributes);
			return yield* Effect.tryPromise({ try: work, catch: (error) => error });
		}).pipe(Effect.withSpan(name)),
	);

await withReplyTrace(RUN_ID, async () => {
	recordReplySpan(RUN_ID, "chat.request", Date.now() - 50, Date.now(), { "ponder.continued": true }, [linkToReply("wrun_01M7AAXEME3MDRQZPA53SJG1W6")]);
	await span("thread.load", { "ponder.messages": 3 }, async () => undefined);
	const reply = streamText({ model: model(), prompt: `Tell me about ${MARKER}`, tools, stopWhen: stepCountIs(3), telemetry: { recordInputs: true, recordOutputs: true } });
	await reply.consumeStream();
	await span("web_fetch.read", {}, () => withPeer("web", async () => (await fetch(`${address}/${MARKER}/page?q=${MARKER}`)).text()));
	await withPeer("web", () => fetch(`${address}/missing/${MARKER}`)).then((response) => response.text());
	await fetch(`${address}/api/v1/chat/completions?q=${MARKER}`, { method: "POST", body: MARKER }).then((response) => response.text());
	await span("workflow.stream.flush", {}, async () => undefined);
	await span("python.run", {}, async () => {
		throw new Error(`the code printed ${MARKER}`);
	}).catch(() => undefined);
	// An Effect span with no Effect parent: its parent is the active span, the reply's root.
	// The AI SDK's spans inside it nest under it, and so do Effect spans inside it.
	effectLog = await stderrOf(() =>
		effects.runPromise(
			Effect.gen(function* () {
				yield* Tracing.annotate({ "ponder.messages": 2, "ponder.skipped": undefined });
				yield* Effect.logWarning("check: a warning inside an Effect span");
				yield* Effect.tryPromise(() => streamText({ model: answeringModel(), prompt: `Tell me about ${MARKER}`, telemetry: { recordInputs: true, recordOutputs: true } }).consumeStream());
				yield* Effect.fail(new CheckFailed()).pipe(Effect.withSpan("Check.failing"), Effect.ignore);
				// A statement's span from Effect's SQL client is not recorded (setup.ts).
				trace.getTracer("check").startSpan(SQL_STATEMENT_SPAN).end();
			}).pipe(Effect.withSpan("Check.effectSpan")),
		),
	);
});
// Outside any reply, an Effect span records nothing either.
await effects.runPromise(Effect.void.pipe(Effect.withSpan("Check.outside")));
// Outside any reply: never traced.
await span("thread.load", { "ponder.messages": 1 }, async () => undefined);
await fetch(`${address}/outside`).then((response) => response.text());
endReplyTrace({ runId: RUN_ID, threadId: "thread-1", model: "test/model", outcome: "saved", continued: true });
server.close();
await tracing.flush();
const spans = exported.getFinishedSpans();
const named = (name: string) => spans.filter((each) => each.name === name);

await check("no exported span holds content", async () => {
	assert.ok(spans.length > 5, `${spans.length} spans`);
	assert.ok(!sent(spans).includes(MARKER), sent(spans));
});

await check("a reply's trace and root span ids come from its run id, the same in every process", async () => {
	const ids = replyIds(RUN_ID);
	assert.deepEqual(replyIds(RUN_ID), ids);
	assert.notDeepEqual(replyIds("wrun_01M7AAXEME3MDRQZPA53SJG1W6"), ids);
	assert.match(ids.traceId, /^[0-9a-f]{32}$/);
	assert.match(ids.spanId, /^[0-9a-f]{16}$/);
	const [root] = named("invoke_agent ponder");
	assert.ok(root, "no root span");
	assert.equal(root.spanContext().traceId, ids.traceId);
	assert.equal(root.spanContext().spanId, ids.spanId);
	assert.equal(root.parentSpanContext, undefined);
	assert.equal(root.attributes["gen_ai.conversation.id"], "thread-1");
	assert.equal(root.attributes["ponder.outcome"], "saved");
	// The root starts when the run started: the time in its id.
	assert.equal(runStartTime(RUN_ID), 1794569583246);
	assert.equal(root.startTime[0], Math.floor(1794569583246 / 1000));
});

await check("everything the reply does is in its trace, under its root", async () => {
	const { traceId, spanId } = replyIds(RUN_ID);
	const inReply = spans.filter((each) => each.name !== "invoke_agent ponder");
	for (const each of inReply) assert.equal(each.spanContext().traceId, traceId, each.name);
	for (const name of ["chat.request", "thread.load", "web_fetch.read", "python.run"]) assert.equal(named(name)[0]?.parentSpanContext?.spanId, spanId, name);
	assert.equal(named("thread.load").length, 1, "a span outside a reply was traced");
	// The continued run's request links to the run it carries on.
	assert.deepEqual(named("chat.request")[0].links[0].context.spanId, replyIds("wrun_01M7AAXEME3MDRQZPA53SJG1W6").spanId);
});

await check("model calls have their model, tokens and time to first token; tools their name", async () => {
	const calls = spans.filter((each) => each.name === "chat test/model");
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.equal(call.attributes["gen_ai.request.model"], "test/model");
		assert.equal(call.attributes["gen_ai.usage.input_tokens"], 120);
		assert.equal(typeof call.attributes["gen_ai.client.operation.time_to_first_chunk"], "number");
	}
	const [toolCall] = named("execute_tool lookup");
	assert.equal(toolCall?.attributes["gen_ai.tool.name"], "lookup");
});

await check("an HTTP span has the method, status and kind of peer, and never the address; the host for OpenRouter only", async () => {
	const requests = spans.filter((each) => each.kind === SpanKind.CLIENT && !each.name.startsWith("chat "));
	const pages = requests.filter((each) => each.attributes["ponder.peer"] === "web");
	assert.equal(pages.length, 2, requests.map((each) => `${each.name} ${each.attributes["ponder.peer"]}`).join(", "));
	for (const request of pages) {
		assert.equal(request.name, "GET");
		assert.equal(request.attributes["server.address"], undefined);
	}
	assert.deepEqual(pages.map((each) => each.attributes["http.response.status_code"]).sort(), [200, 404]);
	assert.equal(pages.find((each) => each.attributes["http.response.status_code"] === 404)?.status.code, SpanStatusCode.ERROR);
	const openRouter = requests.filter((each) => each.attributes["ponder.peer"] === "openrouter");
	assert.equal(openRouter.length, 1);
	assert.equal(openRouter[0].name, "POST");
	assert.equal(openRouter[0].attributes["server.address"], "127.0.0.1");
	assert.equal(openRouter[0].attributes["http.response.status_code"], 200);
});

await check("workflow.stream.flush spans are left out", async () => {
	assert.equal(named("workflow.stream.flush").length, 0);
});

await check("a failure keeps its kind, not its message", async () => {
	const [python] = named("python.run");
	assert.equal(python.status.code, SpanStatusCode.ERROR);
	assert.equal(python.status.message, undefined);
	assert.equal(python.attributes["error.type"], "Error");
});

await check("an Effect span inside a reply is in its trace, under the active span, and the AI SDK's spans nest under it", async () => {
	const { traceId, spanId } = replyIds(RUN_ID);
	const [effectSpan] = named("Check.effectSpan");
	assert.ok(effectSpan, "no Effect span");
	assert.equal(effectSpan.spanContext().traceId, traceId);
	assert.equal(effectSpan.parentSpanContext?.spanId, spanId);
	assert.equal(effectSpan.attributes["ponder.messages"], 2);
	assert.ok(!("ponder.skipped" in effectSpan.attributes));
	// The AI SDK's call starts with its own root, invoke_agent <model>, then a step, then the model call.
	const [call] = named("invoke_agent test/effect");
	assert.ok(call && named("chat test/effect").length === 1, spans.map((each) => each.name).join(", "));
	assert.equal(call.parentSpanContext?.spanId, effectSpan.spanContext().spanId);
	assert.equal(named("Check.failing")[0]?.parentSpanContext?.spanId, effectSpan.spanContext().spanId);
	assert.equal(named("Check.outside").length, 0, "an Effect span outside a reply was traced");
	assert.equal(named(SQL_STATEMENT_SPAN).length, 0, "a SQL statement's span was recorded");
});

await check("a failed Effect span keeps its error's tag, not its message", async () => {
	const [failing] = named("Check.failing");
	assert.equal(failing?.status.code, SpanStatusCode.ERROR);
	assert.equal(failing.status.message, undefined);
	assert.equal(failing.attributes["error.type"], "CheckFailed");
	assert.deepEqual(failing.events.map((event) => [event.name, event.attributes]), [["exception", { "exception.type": "CheckFailed" }]]);
});

await check("an Effect log inside a reply's trace ends with its trace id, as console.warn's lines do", async () => {
	const { traceId } = replyIds(RUN_ID);
	assert.equal(effectLog, `check: a warning inside an Effect span trace_id=${traceId}\n`);
});

await check("a span outside a reply records nothing", async () => {
	const ran = await context.with(trace.deleteSpan(context.active()), () =>
		effects.runPromise(OtelTracer.currentOtelSpan.pipe(Effect.map((active) => active.isRecording()), Effect.withSpan("thread.load"))),
	);
	assert.equal(ran, false);
});

await check("a compaction's span keeps its outcome and counts, and no summary or message text", async () => {
	const compaction = {
		name: "compaction.run",
		kind: SpanKind.INTERNAL,
		spanContext: () => ({ traceId: "a".repeat(32), spanId: "e".repeat(16), traceFlags: TraceFlags.SAMPLED }),
		startTime: [0, 0],
		endTime: [1, 0],
		duration: [1, 0],
		ended: true,
		status: { code: SpanStatusCode.OK },
		// What compaction/compact.ts sets, and what it must never set.
		attributes: { "ponder.between_steps": false, "ponder.last_attempt": false, "ponder.outcome": "compacted", "ponder.tokens": 24_000, "ponder.summary": MARKER, "ponder.messages": MARKER },
		links: [],
		events: [],
		resource: { attributes: {} },
		instrumentationScope: { name: "ponder" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	} as unknown as ReadableSpan;
	const clean = cleanSpan(compaction);
	assert.equal(clean.name, "compaction.run");
	assert.deepEqual(clean.attributes, { "ponder.between_steps": false, "ponder.last_attempt": false, "ponder.outcome": "compacted", "ponder.tokens": 24_000 });
});

await effects.dispose();
process.exit(failed ? 1 : 0);
