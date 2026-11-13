/**
 * What a test tells the fake OpenRouter to answer. Shared by the fake (server.ts) and
 * the tests (fixtures.ts), which send scripts to it over HTTP.
 */

/** One model call: what the model streams back. */
export type Step = {
	/** Thinking, streamed before the text. */
	reasoning?: string;
	/** The reply text, streamed in small pieces. */
	text?: string;
	/** Tools the model calls. The agent runs them and calls the model again: the next step answers that call. */
	/** `id` is the call's id, made up by the fake when left out. Some providers put the tool's name in it. */
	toolCalls?: { name: string; input: unknown; id?: string }[];
	/** Milliseconds between streamed pieces. Use a large value to keep a reply open, such as to test Stop. */
	delayMs?: number;
	/** Answers with this HTTP status and an error, in place of a reply. */
	error?: { status: number; message: string };
	/** What the call cost in US dollars, as OpenRouter reports it. Credits are charged from it. */
	cost?: number;
};

/**
 * A reply to the chat. `match` picks the script: the newest script whose text is in the
 * person's latest message. Each model call in the turn takes the next step, so a script
 * with a tool call has two steps: the call, then the answer after the tool ran.
 */
export type ChatScript = {
	match: string;
	steps: Step[];
	/** The steps instead, when the request carries a summary of the chat (server/compaction/). */
	summarized?: Step[];
};

/** A web search's results (search/openrouter-search.ts), for queries that contain `match`. */
export type SearchScript = { match: string; results: { url: string; title: string; content: string }[] };

/**
 * Memory, for turns whose person's message contains `match`. `save` is the gate's
 * probability that the turn holds something to keep (memory/decision-gate.ts), and
 * `operations` is what the writer answers (memory/extract.ts).
 */
export type MemoryScript = {
	match: string;
	save: number;
	operations?: { op: "add" | "update" | "forget"; id?: string; kind?: "fact" | "project" | "preference"; text?: string; quote?: string; reason?: string }[];
};

/**
 * The summary of a long chat (server/compaction/summarize.ts), for transcripts that
 * contain `match`. Without `text` the summary names the match. `error` answers with that
 * HTTP status instead.
 */
export type SummaryScript = { match: string; text?: string; error?: { status: number; message: string }; delayMs?: number };

/** A summary call as the fake received it: the summarizer's instructions and the transcript it read. */
export type ReceivedSummary = { model: string; system: string; prompt: string; at: number };

/** The window the fake's ZDR list gives a model, in tokens. GLM 5.3's is small, so the compaction tests reach it with a few messages. */
export const SMALL_WINDOW_MODEL = "z-ai/glm-5.3";
export const SMALL_WINDOW = 40_000;

/** An email that Ponder sent, as the fake Cloudflare API received it. */
export type SentEmail = { from: string; to: string; subject: string; text: string; html: string; at: number };

/** A chat call as the fake received it, for tests that check what the model was sent. */
export type ReceivedCall = { model: string; system: string; messages: unknown[]; tools: string[]; provider: unknown; at: number };

/** A span that Ponder exported, as the fake received it (server/tracing/). */
export type ReceivedSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes: Record<string, unknown>;
	events: { name: string; attributes: Record<string, unknown> }[];
	links: { traceId: string; spanId: string }[];
	/** 0 unset, 1 ok, 2 error. */
	statusCode: number;
	/** The server process that sent it (service.instance.id). */
	instance: string;
};
