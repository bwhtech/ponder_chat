import type { Attributes, AttributeValue, SpanStatus } from "@opentelemetry/api";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace";

/**
 * What a span may carry when it leaves Ponder. Admins see usage, never chats (README,
 * "Admin"), and traces keep that promise: names, times, status, token counts, model and
 * provider ids, and the thread and run ids. Never message text, prompts, tool inputs or
 * outputs, connector results, file names, or the path and query of an address, which a
 * prompt injection can fill with private data.
 *
 * The libraries are told not to record content where they make spans (setup.ts). This is
 * the second line: an allowlist, applied to every span before it is exported. A key that
 * is not on it is dropped, so a library that starts to record a new attribute sends
 * nothing until it is added here.
 */

/** Attributes kept with a string value (or a list of strings). */
const TEXT_KEYS = new Set([
	// GenAI semantic conventions (@ai-sdk/otel, and Ponder's own spans).
	"gen_ai.operation.name",
	"gen_ai.provider.name",
	"gen_ai.system",
	"gen_ai.request.model",
	"gen_ai.response.model",
	"gen_ai.response.id",
	"gen_ai.response.finish_reasons",
	"gen_ai.agent.name",
	"gen_ai.conversation.id",
	"gen_ai.tool.name",
	"gen_ai.tool.call.id",
	"gen_ai.tool.type",
	"gen_ai.output.type",
	// The AI SDK's own names for the same.
	"ai.operationId",
	"ai.model.id",
	"ai.model.provider",
	"ai.telemetry.functionId",
	"ai.response.finishReason",
	"ai.response.model",
	"ai.response.id",
	"ai.toolCall.name",
	"ai.toolCall.id",
	// Workflow (@workflow/core). Its error messages, hook tokens and addresses are left out.
	"workflow.name",
	"workflow.operation",
	"workflow.run.id",
	"workflow.run.status",
	"workflow.execution.mode",
	"workflow.result.type",
	"workflow.trace.mode",
	"workflow.delivery.exit_reason",
	"workflow.error.name",
	"workflow.error.code",
	"workflow.route.type",
	"workflow.run.spec_version_source",
	"workflow.replay.load.source",
	"workflow.vm.outcome",
	"workflow.quickjs.snapshot.fallback_reason",
	"workflow.step_start.strategy",
	"workflow.suspension.state",
	"workflow.serialization.operation",
	"workflow.serialization.codec",
	"workflow.resume.trigger",
	"workflow.resume.strategy",
	"workflow.resume.setup_source",
	"workflow.resume_setup_source",
	"workflow.start_hook.outcome",
	"step.name",
	"step.id",
	"step.status",
	"step.result.type",
	"step.error.name",
	"step.skip_reason",
	"step.delivery.decision",
	"step.delivery.reason",
	"deployment.id",
	"faas.instance",
	"messaging.system",
	"messaging.destination.name",
	"messaging.message.id",
	"messaging.operation.type",
	"peer.service",
	"rpc.system",
	"rpc.service",
	"rpc.method",
	// HTTP, without the address's path or query (url.* is never kept).
	"http.request.method",
	"http.route",
	"server.address",
	"error.type",
	"error.category",
	// Ponder's own (span.ts callers).
	"ponder.outcome",
	"ponder.peer",
	"ponder.content_type",
	"ponder.python.status",
	"ponder.search.backend",
]);

/** Attributes kept with a number or a boolean value: counts, sizes, times and flags. */
const NUMBER_PREFIXES = [
	"gen_ai.usage.",
	"gen_ai.client.",
	"gen_ai.execute_tool.",
	"gen_ai.request.max_tokens",
	"gen_ai.request.temperature",
	"gen_ai.request.top_p",
	"gen_ai.request.top_k",
	"gen_ai.request.stream",
	"ai.usage.",
	"ai.response.msToFirstChunk",
	"ai.response.msToFinish",
	"ai.response.avgOutputTokensPerSecond",
	"ai.stream.msToFirstChunk",
	"workflow.",
	"step.",
	"quickjs.",
	"messaging.batch.",
	"http.response.status_code",
	"server.port",
	"error.retryable",
	"ponder.",
];

/**
 * Text values that come from outside Ponder's code: a tool name the model or an MCP server
 * chose, an id or an error name from a provider or a library. Each must look like a name,
 * or it is dropped.
 */
const NAME_VALUE = /^[\w.:/@+-]{1,120}$/;
const NAMED_KEYS = new Set([
	"gen_ai.tool.name",
	"gen_ai.tool.call.id",
	"gen_ai.response.id",
	"gen_ai.response.model",
	"ai.toolCall.name",
	"ai.toolCall.id",
	"ai.response.id",
	"ai.response.model",
	"error.type",
	"step.error.name",
	"workflow.error.name",
	"workflow.error.code",
	"messaging.destination.name",
]);

/**
 * A connector's tools reach the model as `<connector>__<tool>` (mcp/tools.ts), and the
 * connector part is the name the person gave it. Like a connector's host (http.ts), it
 * would tell which apps a person uses, so it becomes "connector". The tool's own name,
 * which the MCP server gives, stays.
 */
const CONNECTOR_TOOL = /^[a-z0-9_]*?__/;
const TOOL_NAME_KEYS = new Set(["gen_ai.tool.name", "ai.toolCall.name"]);
export const withoutConnector = (tool: string) => tool.replace(CONNECTOR_TOOL, "connector__");

/**
 * Spans left out. Workflow makes one `workflow.stream.flush` for each write to a reply's
 * stream: hundreds for a long reply, with nothing to learn from each one.
 */
const DROPPED = new Set(["workflow.stream.flush"]);

/** Events kept, with the same attribute rules. An exception keeps its type only. */
const EVENTS = new Set(["exception", "ai.stream.firstChunk", "ai.stream.finish"]);

/**
 * Span names come from code, with a model id, a tool name or a step name in them. A name
 * of any other shape becomes "span", so a library that names a span after content
 * cannot send it.
 */
const NAME = /^[\w .:/@+-]{1,160}$/;
const KNOWN_NAMES = [
	// One word after the operation: a model id, a tool name, a step number.
	/^(invoke_agent|chat|execute_tool|embeddings|text_completion|generate_content|decide|step) [\w.:/@+-]{1,120}$/,
	/^(workflow|step|queue|hook|webhook|world)\.[\w.]+( [\w.:/@+-]{1,120})?$/,
	/^ai\.[\w.]+$/,
	/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|HTTP)$/,
	/^(chat\.request|credits\.check|queue\.wait|thread\.load|file_context\.resolve|pdf\.extract_text|memory\.(recall|save)|connectors\.list|mcp\.call_tool|search\.query|web_fetch\.read|python\.run|reply\.save|title\.write)$/,
];

export function cleanName(name: string): string {
	if (!NAME.test(name) || !KNOWN_NAMES.some((pattern) => pattern.test(name))) return "span";
	return name.startsWith("execute_tool ") ? `execute_tool ${withoutConnector(name.slice("execute_tool ".length))}` : name;
}

export function cleanAttributes(attributes: Attributes): Attributes {
	const kept: Attributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (!allowed(key, value)) continue;
		kept[key] = TOOL_NAME_KEYS.has(key) && typeof value === "string" ? withoutConnector(value) : value;
	}
	return kept;
}

function allowed(key: string, value: AttributeValue | undefined): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "number" || typeof value === "boolean") return TEXT_KEYS.has(key) || NUMBER_PREFIXES.some((prefix) => key.startsWith(prefix));
	if (!TEXT_KEYS.has(key)) return false;
	const texts = Array.isArray(value) ? value : [value];
	const shape = NAMED_KEYS.has(key) ? NAME_VALUE : /^[^]{0,200}$/;
	return texts.every((text) => text == null || (typeof text === "string" && shape.test(text)));
}

function cleanEvents(events: TimedEvent[]): TimedEvent[] {
	return events
		.filter((event) => EVENTS.has(event.name))
		.map((event) => ({
			name: event.name,
			time: event.time,
			droppedAttributesCount: 0,
			attributes:
				event.name === "exception"
					? typeof event.attributes?.["exception.type"] === "string" && /^[\w.-]{1,60}$/.test(event.attributes["exception.type"])
						? { "exception.type": event.attributes["exception.type"] }
						: {}
					: cleanAttributes(event.attributes ?? {}),
		}));
}

/** A copy of the span with only what may leave Ponder. The span itself is not changed. */
export function cleanSpan(span: ReadableSpan): ReadableSpan {
	const status: SpanStatus = { code: span.status.code };
	return {
		name: cleanName(span.name),
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		duration: span.duration,
		ended: span.ended,
		status,
		attributes: cleanAttributes(span.attributes),
		links: span.links.map((link) => ({ context: link.context })),
		events: cleanEvents(span.events),
		resource: span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
	};
}

/** Exports clean copies of the spans (cleanSpan) through `next`. */
export class PrivacyExporter implements SpanExporter {
	constructor(private next: SpanExporter) {}

	export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
		this.next.export(spans.filter((span) => !DROPPED.has(span.name)).map(cleanSpan), done);
	}

	shutdown() {
		return this.next.shutdown();
	}

	forceFlush() {
		return this.next.forceFlush?.() ?? Promise.resolve();
	}
}
