import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MODELS } from "../../server/models/Models.ts";
import { jsonBody, parseJson } from "../../server/test-json.ts";
import { SMALL_WINDOW, SMALL_WINDOW_MODEL, type ChatScript, type MemoryScript, type PageScript, type ReceivedCall, type ReceivedSpan, type ReceivedSummary, type SearchScript, type SentEmail, type Step, type SummaryScript } from "./script.ts";

/**
 * A fake OpenRouter, and a fake Cloudflare email API, for the end-to-end tests. Ponder
 * reaches it through OPENROUTER_BASE_URL and CLOUDFLARE_API_URL (server/openrouter/OpenRouter.ts,
 * server/email/Mailer.ts), so the tests need no API key and spend nothing.
 *
 * It answers each kind of call Ponder makes:
 * - chat replies, streamed in OpenRouter's format, with tool calls (`ChatScript`);
 * - thread titles: the first words of the person's message;
 * - web search: url_citation annotations (`SearchScript`);
 * - memory: the decision gate and the writer (`MemoryScript`), and embeddings;
 * - chat summaries, when a chat gets too long (`SummaryScript`);
 * - the PDF pages a workspace document sends to a model (`PageScript`), and in a workspace
 *   chat, the line of its documents or excerpts that best matches the question, so a test
 *   sees which of them reached the model;
 * - the list of models with private (ZDR) endpoints: every model Ponder lists, with
 *   a 1M-token window, except GLM 5.3's small one (SMALL_WINDOW).
 * - what a streamed reply cost, by its generation id (`GET /api/v1/generation`).
 *
 * It also takes the traces that Ponder sends with OTLP over HTTP (server/tracing/), in
 * place of Jaeger, so tracing.spec.ts can read them.
 *
 * Tests send scripts and read what Ponder sent over HTTP, at /__fake/* (fixtures.ts),
 * because they run in other processes. A message that no script matches gets
 * "You said: <message>", so a test that only needs a reply needs no script.
 */
export function fakeApp() {
	const chats: ChatScript[] = [];
	const searches: SearchScript[] = [];
	const memories: MemoryScript[] = [];
	const emails: SentEmail[] = [];
	const calls: ReceivedCall[] = [];
	const spans: ReceivedSpan[] = [];
	// Each OTLP request as it came, so a test can look for text anywhere in it.
	const exports: string[] = [];
	const summaryScripts: SummaryScript[] = [];
	const summaries: ReceivedSummary[] = [];
	const pageScripts: PageScript[] = [];
	/** How many calls each step of a script has had, for `failFirst`. */
	const attempts = new Map<string, number>();
	const app = new Hono();

	// --- Control, for the tests. The newest script wins, so a test can replace one.
	app.get("/__fake/health", (c) => c.text("ok"));
	app.post("/__fake/chat", async (c) => (chats.unshift(await jsonBody<ChatScript>(c.req)), c.json({ ok: true })));
	app.post("/__fake/search", async (c) => (searches.unshift(await jsonBody<SearchScript>(c.req)), c.json({ ok: true })));
	app.post("/__fake/memory", async (c) => (memories.unshift(await jsonBody<MemoryScript>(c.req)), c.json({ ok: true })));
	app.post("/__fake/summary", async (c) => (summaryScripts.unshift(await jsonBody<SummaryScript>(c.req)), c.json({ ok: true })));
	app.post("/__fake/page", async (c) => (pageScripts.unshift(await jsonBody<PageScript>(c.req)), c.json({ ok: true })));
	const since = (query: string | undefined) => Number(query ?? 0);
	app.get("/__fake/emails", (c) => c.json(emails.filter((email) => email.to === c.req.query("to") && email.at >= since(c.req.query("since")))));
	app.get("/__fake/spans", (c) => c.json({ spans, exports }));
	app.get("/__fake/summaries", (c) =>
		c.json(summaries.filter((call) => call.at >= since(c.req.query("since")) && call.prompt.includes(c.req.query("match") ?? ""))),
	);
	app.get("/__fake/calls", (c) =>
		c.json(calls.filter((call) => call.at >= since(c.req.query("since")) && latestUserText(call.messages as Message[]).includes(c.req.query("match") ?? ""))),
	);

	// --- OpenRouter. Like OpenRouter, it refuses a call without the key Ponder was given
	// (start.ts). The list of ZDR endpoints is public.
	app.use("/api/*", async (c, next) => {
		if (c.req.path === "/api/v1/endpoints/zdr" || c.req.header("authorization") === `Bearer ${FAKE_KEY}`) return next();
		return c.json({ error: { code: 401, message: "No auth credentials found" } }, 401);
	});
	app.get("/api/v1/endpoints/zdr", (c) =>
		c.json({ data: MODELS.map((model) => ({ model_id: model.id, provider_name: "Fake", context_length: model.id === SMALL_WINDOW_MODEL ? SMALL_WINDOW : 1_000_000 })) }),
	);
	app.get("/api/v1/key", (c) => c.json({ data: { label: "fake" } }));

	app.post("/api/v1/chat/completions", async (c) => {
		const body = await jsonBody<Completion>(c.req);
		const messages = body.messages ?? [];
		const pdf = pagePdf(messages);
		if (pdf) {
			const { status, answer } = pageReply(body.model, pdf, pageScripts, attempts);
			return c.json(answer, status as 200);
		}
		if (body.tools?.some((tool) => tool.type === "openrouter:web_search")) return c.json(searchReply(body.model, latestUserText(messages), searches));
		const schema = body.response_format?.json_schema?.schema?.properties ?? {};
		if ("title" in schema) return c.json(jsonReply(body.model, { title: titleOf(latestUserText(messages)) }));
		if ("operations" in schema) return c.json(jsonReply(body.model, writerReply(latestUserText(messages), memories)));
		const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
		if (system.startsWith(SUMMARIZER)) {
			const prompt = latestUserText(messages);
			summaries.push({ model: body.model, system, prompt, at: Date.now() });
			const script = summaryScripts.find((candidate) => prompt.includes(candidate.match));
			if (script?.delayMs) await new Promise((resolve) => setTimeout(resolve, script.delayMs));
			if (script?.error) return c.json({ error: { code: script.error.status, message: script.error.message } }, script.error.status as 400);
			return c.json(textReply(body.model, { text: script?.text ?? `Summary of the chat about ${script?.match ?? "earlier things"}.`, cost: 0.00005 }, promptTokens(body)));
		}

		calls.push({
			model: body.model,
			system,
			messages,
			tools: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.type),
			provider: body.provider,
			plugins: body.plugins ?? [],
			sessionId: body.session_id,
			at: Date.now(),
		});
		const { step, key } = chatStep(messages, chats, system);
		const attempt = (attempts.get(key) ?? 0) + 1;
		attempts.set(key, attempt);
		const fails = step.failFirst === undefined ? Boolean(step.error) : attempt <= step.failFirst;
		const error = step.error ?? { status: 502, message: "Provider returned error" };
		if (fails && step.breakAfter === undefined) return c.json({ error: { code: error.status, message: error.message } }, error.status as 400);
		const answering = answeringModel(body.model);
		if (!body.stream) return c.json(textReply(answering, step, promptTokens(body)));
		return streamReply(answering, step, c.req.raw.signal, promptTokens(body), fails ? { after: step.breakAfter!, error } : undefined);
	});

	app.get("/api/v1/generation", (c) => {
		const generation = generations.get(c.req.query("id") ?? "");
		if (!generation) return c.json({ error: { code: 404, message: "Generation not found" } }, 404);
		return c.json({ data: { id: c.req.query("id"), total_cost: generation.cost, tokens_prompt: 500, tokens_completion: generation.tokens } });
	});

	app.post("/api/v1/embeddings", async (c) => {
		const body = await jsonBody<{ model: string; input: string | string[] }>(c.req);
		const inputs = Array.isArray(body.input) ? body.input : [body.input];
		return c.json({
			object: "list",
			model: body.model,
			data: inputs.map((text, index) => ({ object: "embedding", index, embedding: embedding(text) })),
			usage: { prompt_tokens: inputs.join(" ").length, total_tokens: inputs.join(" ").length, cost: 0 },
		});
	});

	app.post("/api/alpha/decisions", async (c) => {
		const body = await jsonBody<{ state?: { person_said?: string } }>(c.req);
		const script = memories.find((memory) => (body.state?.person_said ?? "").includes(memory.match));
		return c.json({ answers: { save: { noul: script?.save ?? 0.05 }, refuse: { noul: 0.01 } }, usage: { cost: 0, input_tokens: 100, output_tokens: 0 } });
	});

	// --- Cloudflare Email Service.
	app.post("/client/v4/accounts/:account/email/sending/send", async (c) => {
		emails.push({ ...(await jsonBody<Omit<SentEmail, "at">>(c.req)), at: Date.now() });
		return c.json({ success: true });
	});

	// --- OTLP over HTTP, in JSON, as the exporter sends it.
	app.post("/v1/traces", async (c) => {
		const body = await c.req.text();
		exports.push(body);
		spans.push(...spansIn(parseJson<OtlpRequest>(body)));
		return c.json({});
	});

	app.all("*", (c) => {
		console.warn(`fake: no route for ${c.req.method} ${c.req.path}`);
		return c.json({ error: { message: `The fake has no route for ${c.req.method} ${c.req.path}.` } }, 404);
	});
	return app;
}

/** The API key that start.ts gives Ponder. */
export const FAKE_KEY = "sk-or-fake";

export function startFake(port: number) {
	return serve({ fetch: fakeApp().fetch, port, hostname: "127.0.0.1" });
}

// --- Chat replies -------------------------------------------------------------

type Message = { role: string; content: string | { type: string; text?: string; file?: { filename?: string; file_data?: string } }[] | null };
type Completion = {
	model: string;
	stream?: boolean;
	provider?: unknown;
	plugins?: unknown[];
	session_id?: string;
	messages?: Message[];
	tools?: { type: string; function?: { name: string } }[];
	response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
};

const DEFAULT_COST = 0.0002;
/** How the summarizer's instructions start (server/compaction/prompt.ts). */
const SUMMARIZER = "You write the summary of a chat between a person and Ponder";

/** The input tokens OpenRouter would report: about a token for 4 characters of what was sent. */
function promptTokens(body: Completion) {
	return Math.ceil(JSON.stringify([body.messages ?? [], body.tools ?? []]).length / 4);
}

/** What each streamed reply cost, by its generation id, as OpenRouter's generation API tells. */
const generations = new Map<string, { cost: number; tokens: number }>();
let generationCount = 0;

/**
 * The step for this call: the turn's script, at the number of model calls made since the person's message.
 * With no script, "You said: <message>", and in a workspace chat also the first line of the workspace's
 * instructions and the line of its documents that best matches the message, so a test can see that
 * they reached the model (workspaces.spec.ts, workspaces-documents.spec.ts).
 */
function chatStep(messages: Message[], scripts: ChatScript[], system: string): { step: Step; key: string } {
	const said = latestUserText(messages);
	const script = scripts.find((candidate) => said.includes(candidate.match));
	if (!script) {
		const question = withoutExcerpts(said);
		return { step: { text: [`You said: ${question}`, workspaceLine(system), documentLine(system, said, question)].filter(Boolean).join("\n\n") }, key: "" };
	}
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const callsSince = messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
	const summarized = messages.some((message) => message.role === "user" && textOf(message.content).startsWith("<summary>"));
	const steps = (summarized && script.summarized) || script.steps;
	const index = Math.min(callsSince, steps.length - 1);
	return { step: steps[index], key: `${script.match}#${summarized ? "summarized" : "steps"}#${index}` };
}

/**
 * The reply as OpenRouter streams it: server-sent chat completion chunks, then the usage.
 * With `broken`, it stops after that many pieces with an error chunk, and no usage.
 */
function streamReply(model: string, step: Step, signal: AbortSignal, prompt: number, broken?: { after: number; error: { status: number; message: string } }) {
	const id = `gen-fake-${Date.now()}-${++generationCount}`;
	generations.set(id, { cost: step.cost ?? DEFAULT_COST, tokens: usage(step).completion_tokens });
	const chunk = (delta: object, finish: string | null = null, usage?: object) =>
		`data: ${JSON.stringify({ id, model, provider: "Fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta, finish_reason: finish }], ...(usage && { usage }) })}\n\n`;
	const parts: string[] = [chunk({ role: "assistant", content: "" })];
	for (const piece of pieces(step.reasoning)) parts.push(chunk({ reasoning: piece }));
	for (const piece of pieces(step.text)) parts.push(chunk({ content: piece }));
	for (const [index, call] of (step.toolCalls ?? []).entries()) {
		const args = JSON.stringify(call.input).slice(0, call.cutAfter);
		parts.push(chunk({ tool_calls: [{ index, id: call.id ?? `call_${id}_${index}`, type: "function", function: { name: call.name, arguments: "" } }] }));
		const size = step.toolInputPieces ? Math.ceil(args.length / step.toolInputPieces) : 40;
		for (let at = 0; at < args.length; at += size) parts.push(chunk({ tool_calls: [{ index, function: { arguments: args.slice(at, at + size) } }] }));
	}
	parts.push(chunk({}, step.toolCalls?.length ? "tool_calls" : "stop", usage(step, prompt)));
	parts.push("data: [DONE]\n\n");
	if (broken) parts.splice(1 + broken.after, parts.length, `data: ${JSON.stringify({ id, model, error: { code: broken.error.status, message: broken.error.message } })}\n\n`);

	const encoder = new TextEncoder();
	const delay = step.delayMs ?? 5;
	return new Response(
		new ReadableStream({
			async start(controller) {
				for (const part of parts) {
					if (signal.aborted) return;
					controller.enqueue(encoder.encode(part));
					if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				}
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
	);
}

/** Auto answers as a model on Ponder's list, named with a date as OpenRouter may name it. */
const AUTO_ANSWERS_AS = "anthropic/claude-haiku-5.5";

function answeringModel(model: string) {
	return model === "openrouter/auto" ? `${AUTO_ANSWERS_AS}-20261001` : model;
}

/** A few words at a time, as a model streams. */
function pieces(text: string | undefined) {
	return text?.match(/(\S+\s*){1,3}|\s+/g) ?? [];
}

function usage(step: Step, prompt = 500) {
	const completion = Math.ceil(((step.text ?? "").length + JSON.stringify(step.toolCalls ?? []).length) / 4);
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost: step.cost ?? DEFAULT_COST };
}

function textReply(model: string, step: Step, prompt?: number) {
	const toolCalls = step.toolCalls?.map((call, index) => ({ id: call.id ?? `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }));
	return {
		id: `gen-fake-${Date.now()}`,
		model,
		choices: [{ index: 0, message: { role: "assistant", content: step.text ?? "", tool_calls: toolCalls }, finish_reason: toolCalls?.length ? "tool_calls" : "stop" }],
		usage: usage(step, prompt),
	};
}

function jsonReply(model: string, value: unknown) {
	return textReply(model, { text: JSON.stringify(value), cost: 0.00001 });
}

// --- Titles, search and memory ------------------------------------------------

/** The first five words of the person's message, which thread-title.ts quotes after its first line. */
function titleOf(prompt: string) {
	const message = prompt.slice(prompt.indexOf("\n") + 1);
	return message.split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
}

function searchReply(model: string, query: string, scripts: SearchScript[]) {
	const results = scripts.find((script) => query.includes(script.match))?.results ?? [
		{ url: "https://example.com/first", title: "First result", content: `A page about ${query}.` },
		{ url: "https://example.org/second", title: "Second result", content: `Another page about ${query}.` },
	];
	return {
		...textReply(model, { text: "done", cost: 0.007 }),
		choices: [
			{
				index: 0,
				finish_reason: "stop",
				message: { role: "assistant", content: "done", annotations: results.map((result) => ({ type: "url_citation", url_citation: result })) },
			},
		],
	};
}

/** What the memory writer answers: the script's operations, with every field it requires. */
function writerReply(prompt: string, scripts: MemoryScript[]) {
	const said = prompt.match(/The person said:\n(.*)/)?.[1] ?? "";
	const script = scripts.find((memory) => said.includes(memory.match));
	const operations = (script?.operations ?? []).map((o) => ({ id: "", kind: "fact", text: "", quote: "", reason: "The test said so.", ...o }));
	return { summary: operations.length ? "Saved what the test asked." : "Nothing to save.", operations };
}

/**
 * A small vector from the words of the text, so texts that share words are near each
 * other, as memory search (memory/pgvector-index.ts) expects.
 */
function embedding(text: string) {
	const vector = new Array<number>(32).fill(0);
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
		let hash = 0;
		for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
		vector[hash % vector.length] += 1;
	}
	// Never all zeros: pgvector's cosine distance has no answer for a zero vector.
	vector[vector.length - 1] += 0.01;
	const length = Math.hypot(...vector);
	return vector.map((value) => value / length);
}

// --- Messages -----------------------------------------------------------------

function textOf(content: Message["content"]) {
	if (typeof content === "string") return content;
	return (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** The text of the person's latest message. */
function latestUserText(messages: Message[]) {
	const message = messages.findLast((candidate) => candidate.role === "user");
	return message ? textOf(message.content) : "";
}

/** "Workspace “<name>” says: <first line of its instructions>", from the system prompt's <workspace> block; "" outside a workspace. */
function workspaceLine(system: string) {
	const block = /<workspace name="([^"]*)">\n([^\n]*)/.exec(system);
	return block ? `Workspace “${block[1]}” says: ${block[2]}` : "";
}

// --- Workspace documents ------------------------------------------------------

/** The person's message without the <workspace_excerpts> block that Ponder puts before it. */
function withoutExcerpts(said: string) {
	return said.replace(/<workspace_excerpts>[\s\S]*?<\/workspace_excerpts>\n*/g, "").trim();
}

/**
 * The line of the workspace's text that shares the most words with the question, as a model
 * that answers from it would quote it: from a whole document in the system prompt, “From the
 * document “<name>”: …”, or from an excerpt with the message, “From the excerpt “<location>”: …”.
 * "" when no line shares a word, or outside a workspace.
 */
function documentLine(system: string, said: string, question: string) {
	const words = new Set(wordsOf(question).filter((word) => word.length > 3));
	if (words.size === 0) return "";
	const candidates: { source: string; line: string }[] = [];
	for (const [, name, text] of system.matchAll(/<document name="([^"]*)">\n([\s\S]*?)\n<\/document>/g)) {
		for (const line of text.split("\n")) candidates.push({ source: `the document “${name}”`, line });
	}
	const excerpts = /<workspace_excerpts>\n([\s\S]*?)\n<\/workspace_excerpts>/.exec(said)?.[1] ?? "";
	for (const excerpt of excerpts.split(/\n\n(?=\[\d+\] )/)) {
		const [location = "", ...lines] = excerpt.split("\n");
		for (const line of lines) candidates.push({ source: `the excerpt “${location.replace(/^\[\d+\] /, "")}”`, line });
	}
	let best: { source: string; line: string; score: number } | undefined;
	for (const candidate of candidates) {
		const score = wordsOf(candidate.line).filter((word) => words.has(word)).length;
		if (score > (best?.score ?? 0)) best = { ...candidate, score };
	}
	return best ? `From ${best.source}: ${best.line.trim()}` : "";
}

function wordsOf(text: string) {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The one-page PDF of a page read (page-reader.ts), as text; none for any other call. */
function pagePdf(messages: Message[]) {
	for (const message of messages) {
		if (typeof message.content === "string" || !message.content) continue;
		for (const part of message.content) {
			const data = part.type === "file" ? part.file?.file_data : undefined;
			if (data?.startsWith("data:application/pdf;base64,")) {
				const page = Number(/page-(\d+)\.pdf/.exec(part.file?.filename ?? "")?.[1] ?? 0);
				return { page, text: Buffer.from(data.slice(data.indexOf(",") + 1), "base64").toString("latin1") };
			}
		}
	}
	return undefined;
}

/**
 * The page model's answer: the script's text, or its refusal for the first `failFirst` calls.
 * A refusal is a 400, which the page reader does not try again, so each read is one call.
 */
function pageReply(model: string, pdf: { page: number; text: string }, scripts: PageScript[], attempts: Map<string, number>) {
	const script = scripts.find((candidate) => pdf.text.includes(candidate.match));
	const key = `page#${script?.match ?? ""}#${pdf.page}`;
	const attempt = (attempts.get(key) ?? 0) + 1;
	attempts.set(key, attempt);
	if (script && attempt <= (script.failFirst ?? 0)) {
		return { status: 400, answer: { error: { code: 400, message: script.error ?? "The fake model could not read this page." } } };
	}
	const text = script?.text ?? `Page ${pdf.page}, as the fake model read it.`;
	return { status: 200, answer: { ...textReply(model, { text, cost: PAGE_COST }, 1_200), id: `gen-fake-page-${Date.now()}-${attempt}` } };
}

const PAGE_COST = 0.0018;

// --- Traces -------------------------------------------------------------------

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: { values?: OtlpValue[] } };
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes?: OtlpAttribute[];
	events?: { name: string; attributes?: OtlpAttribute[] }[];
	links?: { traceId: string; spanId: string }[];
	status?: { code?: number; message?: string };
	startTimeUnixNano?: string;
	endTimeUnixNano?: string;
};
type OtlpRequest = { resourceSpans?: { resource?: { attributes?: OtlpAttribute[] }; scopeSpans?: { spans?: OtlpSpan[] }[] }[] };

function spansIn(request: OtlpRequest): ReceivedSpan[] {
	return (request.resourceSpans ?? []).flatMap((resource) =>
		(resource.scopeSpans ?? []).flatMap((scope) =>
			(scope.spans ?? []).map((span) => ({
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId || undefined,
				name: span.name,
				attributes: attributesOf(span.attributes),
				events: (span.events ?? []).map((event) => ({ name: event.name, attributes: attributesOf(event.attributes) })),
				links: (span.links ?? []).map((link) => ({ traceId: link.traceId, spanId: link.spanId })),
				statusCode: span.status?.code ?? 0,
				durationMs: Number((BigInt(span.endTimeUnixNano ?? "0") - BigInt(span.startTimeUnixNano ?? "0")) / 1_000_000n),
				instance: String(attributesOf(resource.resource?.attributes)["service.instance.id"] ?? ""),
			})),
		),
	);
}

function attributesOf(attributes: OtlpAttribute[] = []): Record<string, unknown> {
	return Object.fromEntries(attributes.map(({ key, value }) => [key, valueOf(value)]));
}

function valueOf(value: OtlpValue): unknown {
	if (value.arrayValue) return (value.arrayValue.values ?? []).map(valueOf);
	if (value.intValue !== undefined) return Number(value.intValue);
	return value.stringValue ?? value.doubleValue ?? value.boolValue;
}
