import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NetGuard from "../net/NetGuard.ts";
import type { AuthKind, Transport } from "./ConnectorStore.ts";
import { ConnectorProblem, describeError } from "./errors.ts";

/**
 * What an MCP server URL needs, before the person adds it: which transport answers, and
 * whether it wants no sign-in, an OAuth sign-in, or a key. One initialize request over
 * Streamable HTTP, then the old SSE transport when that is refused. A 401 with OAuth
 * metadata (RFC 9728, or RFC 8414 for older servers) means OAuth; any other 401 means a key.
 */
export type ProbeResult =
	| { ok: true; transport: Transport; auth: AuthKind; name?: string; message: string }
	| { ok: false; message: string };

const TIMEOUT = "10 seconds";
const PROTOCOL_VERSION = "2025-06-18";

/** What the probe keeps of an answer. Its body is read or cancelled inside the request's time limit. */
type Answer = { status: number; ok: boolean; headers: Headers; name?: string; eventStream?: boolean };

/** The server's answer to initialize, as JSON or as one SSE event. Only the name is read. */
const InitializeAnswer = Schema.fromJsonString(
	Schema.Struct({
		result: Schema.optional(Schema.Struct({ serverInfo: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), title: Schema.optional(Schema.String) })) })),
	}),
);
const decodeInitialize = Schema.decodeUnknownOption(InitializeAnswer);

/** OAuth metadata: only whether it names an authorization server or endpoint. */
const AuthMetadata = Schema.Struct({
	authorization_servers: Schema.optional(Schema.Array(Schema.Unknown)),
	authorization_endpoint: Schema.optional(Schema.String),
});
const decodeAuthMetadata = Schema.decodeUnknownOption(AuthMetadata);

/** Never fails: what went wrong is the result, for the person. Every request goes through the guarded fetch (net/NetGuard.ts). */
export const probe = Effect.fn("Connectors.probe")(function* (address: string) {
	const guard = yield* NetGuard.NetGuard;
	const problem = guard.mcpUrlProblem(address);
	if (Option.isSome(problem)) return { ok: false, message: problem.value } satisfies ProbeResult;
	const url = new URL(address);

	/** One request, with its body read by `read`, within TIMEOUT, as AbortSignal.timeout covered both. */
	const request = <A>(target: URL, init: RequestInit, read: (response: Response) => Promise<A>) =>
		Effect.tryPromise({ try: async (signal) => read(await guard.fetch(target, { ...init, signal })), catch: (error) => error }).pipe(Effect.timeout(TIMEOUT));

	const run = Effect.gen(function* () {
		const http = yield* request(url, initialize, async (response): Promise<Answer> => {
			const answer = { status: response.status, ok: response.ok, headers: response.headers };
			if (response.ok) return { ...answer, name: await serverName(response) };
			await response.body?.cancel();
			return answer;
		});
		if (http.status === 401) return found(url, "http", yield* authKind(url, http.headers));
		if (http.ok) {
			yield* endSession(url, http.headers.get("mcp-session-id"));
			return found(url, "http", "none", http.name);
		}
		if ([400, 404, 405, 406, 415].includes(http.status)) {
			const sse = yield* request(url, { headers: { accept: "text/event-stream" } }, async (response): Promise<Answer> => {
				await response.body?.cancel();
				return { status: response.status, ok: response.ok, headers: response.headers, eventStream: response.headers.get("content-type")?.startsWith("text/event-stream") };
			});
			if (sse.status === 401) return found(url, "sse", yield* authKind(url, sse.headers));
			if (sse.ok && sse.eventStream) return found(url, "sse", "none");
		}
		if (http.status === 403) return found(url, "http", "headers");
		return { ok: false, message: `The server answered HTTP ${http.status}. Check the address: it usually ends in /mcp.` } satisfies ProbeResult;
	});

	/** Ends the session the probe opened, as the spec asks of clients that are done. */
	const endSession = (target: URL, sessionId: string | null) =>
		sessionId ? request(target, { method: "DELETE", headers: { "mcp-session-id": sessionId } }, async (response) => void (await response.body?.cancel())).pipe(Effect.ignore) : Effect.void;

	const authKind = Effect.fnUntraced(function* (target: URL, headers: Headers) {
		if (/resource_metadata=/i.test(headers.get("www-authenticate") ?? "")) return "oauth" as const;
		const path = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
		const candidates = [`/.well-known/oauth-protected-resource${path}`, "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"];
		let failure: unknown;
		let answered = false;
		for (const candidate of candidates) {
			const metadata = yield* request(new URL(candidate, target.origin), { headers: { accept: "application/json" } }, async (response) => {
				if (!response.ok) {
					await response.body?.cancel();
					return Option.none<unknown>();
				}
				return Option.some<unknown>(await response.json().catch(() => ({})));
			}).pipe(Effect.result);
			if (Result.isFailure(metadata)) {
				failure = metadata.failure;
				continue;
			}
			answered = true;
			const read = Option.flatMap(metadata.success, decodeAuthMetadata);
			if (Option.isSome(read) && (read.value.authorization_servers?.length || read.value.authorization_endpoint)) return "oauth" as const;
		}
		// No metadata address answered at all (a timeout, the network): that says nothing about
		// the sign-in. "A key" would send the person to the wrong form for an OAuth server.
		if (!answered) {
			yield* Effect.logWarning(`connectors: no OAuth metadata address of ${target.host} answered:`, describeError(failure));
			return yield* new ConnectorProblem({ reason: "metadata-unreachable" });
		}
		return "headers" as const;
	});

	return yield* run.pipe(Effect.catch((error) => Effect.succeed<ProbeResult>({ ok: false, message: describeError(error) })));
});

function found(url: URL, transport: Transport, auth: AuthKind, name?: string): ProbeResult {
	const host = url.hostname.replace(/^mcp\./, "");
	const message = {
		none: "No sign-in needed. Anyone with the address can use this server.",
		oauth: `Uses sign-in. You sign in to ${host} in a new window.`,
		headers: "This server needs an API key. Add it as a header below.",
	}[auth];
	return { ok: true, transport, auth, name, message };
}

const initialize: RequestInit = {
	method: "POST",
	headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION },
	body: JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Ponder Chat", version: "1.0.0" } },
	}),
};

/** The name the server gives itself in its initialize answer, as JSON or as one SSE event. */
async function serverName(response: Response): Promise<string | undefined> {
	try {
		const type = response.headers.get("content-type") ?? "";
		let body: string;
		if (type.startsWith("text/event-stream")) {
			const reader = response.body!.getReader();
			const { value } = await reader.read();
			await reader.cancel();
			body = /^data:\s*(.+)$/m.exec(new TextDecoder().decode(value))?.[1] ?? "";
		} else body = await response.text();
		const answer = decodeInitialize(body);
		return Option.getOrUndefined(Option.flatMap(answer, (read) => Option.fromUndefinedOr(read.result?.serverInfo?.title ?? read.result?.serverInfo?.name)));
	} catch {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
}
