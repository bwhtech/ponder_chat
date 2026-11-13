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
	toolCalls?: { name: string; input: unknown }[];
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
export type ChatScript = { match: string; steps: Step[] };

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
