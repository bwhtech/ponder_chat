import { type Context, Hono } from "hono";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import * as Auth from "../auth/Auth.ts";
import { limitPerPerson } from "../rate-limit.ts";
import type { Services } from "../runtime/layer.ts";
import { route } from "../runtime/route.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import * as Connectors from "./Connectors.ts";
import { ConnectorFailed, ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import { probe } from "./probe.ts";
import { validate } from "../validate.ts";
import type { SignInMessage } from "../../shared/connectors.ts";

/**
 * /api/connectors: the signed-in person's connectors (app.ts mounts it after the session
 * check). The OAuth callback is outside /api, at /oauth/mcp/callback, because the
 * person's browser lands there from the server's sign-in page.
 */
type Env = SignedInEnv;

const userOf = (c: Context<Env>) => c.get("user").id;
const idOf = (c: Context<Env>) => c.req.param("id") ?? "";
const limited = limitPerPerson("connector", userOf);

const headerList = z.array(z.object({ name: z.string().max(100), value: z.string().max(4_000) })).max(10);
const newConnector = z.object({
	name: z.string().trim().min(1, "Enter a name.").max(60),
	url: z.string().trim().min(1, "Enter the server URL.").max(2_000),
	transport: z.enum(["http", "sse"]).default("http"),
	auth: z.enum(["none", "headers", "oauth"]),
	headers: headerList.default([]),
	clientId: z.string().trim().max(500).optional(),
	clientSecret: z.string().trim().max(2_000).optional(),
});
const change = z.object({
	name: z.string().trim().min(1).max(60).optional(),
	enabled: z.boolean().optional(),
	rules: z.record(z.string(), z.enum(["allow", "ask", "off"]).nullable()).optional(),
	headers: headerList.optional(),
});
const probeBody = z.object({ url: z.string().trim().max(2_000) });

/** One method of the Connectors service. */
const connectors = <A, E>(use: (service: Connectors.Connectors["Service"]) => Effect.Effect<A, E>) => Connectors.Connectors.use(use);

export const connectorsApi = new Hono<Env>()
	.get("/", (c) => answer(c, Effect.map(connectors((service) => service.listConnectors(userOf(c))), (list) => ({ connectors: list }))))

	.post("/probe", limited, validate("json", probeBody), (c) => answer(c, probe(c.req.valid("json").url)))

	.post("/", limited, validate("json", newConnector), (c) => answer(c, Effect.flatMap(Auth.appOrigin(c.req.raw.headers), (origin) => connectors((service) => service.addConnector(userOf(c), origin, c.req.valid("json"))))))

	.post("/:id/sign-in", limited, (c) => answer(c, Effect.flatMap(Auth.appOrigin(c.req.raw.headers), (origin) => connectors((service) => service.signInAgain(userOf(c), origin, idOf(c))))))

	.post("/:id/refresh", limited, (c) => answer(c, Effect.map(connectors((service) => service.refreshConnector(userOf(c), idOf(c))), (connector) => ({ connector }))))

	.patch("/:id", validate("json", change), (c) =>
		answer(c, Effect.map(connectors((service) => service.changeConnector(userOf(c), idOf(c), c.req.valid("json"))), (connector) => ({ connector }))),
	)

	.delete("/:id", (c) =>
		answer(
			c,
			Effect.flatMap(connectors((service) => service.removeConnector(userOf(c), idOf(c))), (removed) =>
				removed ? Effect.succeed({ ok: true }) : Effect.fail(new ConnectorProblem({ reason: "not-found" })),
			),
		),
	);

/**
 * Runs a request: a problem the person can fix is a 400 with its message. The MCP SDK
 * checks a server's replies with zod, and its message says what the server got wrong.
 * Anything else, a bug too, is a 502 with a short reason, and logged.
 */
function answer<T extends object, E>(c: Context<Env>, effect: Effect.Effect<T, E, Services>) {
	return route(
		c,
		effect.pipe(
			Effect.map((value) => c.json(value)),
			Effect.catchCause((cause) => refusal(c, cause)),
		),
	);
}

const problemAnswer = (c: Context<Env>, error: string) => c.json({ error }, 400);
const failureAnswer = (c: Context<Env>, error: string) => c.json({ error }, 502);

function refusal(c: Context<Env>, cause: Cause.Cause<unknown>): Effect.Effect<ReturnType<typeof problemAnswer> | ReturnType<typeof failureAnswer>> {
	if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
	const error = Cause.squash(cause);
	const zod = error instanceof ConnectorFailed ? error.cause : error;
	if (zod instanceof z.ZodError) return Effect.succeed(problemAnswer(c, zod.issues[0]?.message ?? "That request is not valid."));
	if (error instanceof ConnectorProblem || error instanceof NeedsSignIn) return Effect.succeed(problemAnswer(c, error.message));
	return Effect.as(Effect.logWarning("connectors:", error), failureAnswer(c, describeError(error)));
}

/**
 * GET /oauth/mcp/callback: the end of an OAuth sign-in. The person's session must be the
 * one that started it. The page tells Ponder's other pages (web/connectors/sign-in.ts)
 * and closes; on a phone, where the sign-in used the same tab, it goes back to Settings,
 * Connectors.
 */
export function oauthCallback(c: Context) {
	const query = c.req.query();
	return route(
		c,
		Effect.gen(function* () {
			const found = yield* Auth.Auth.use((auth) => auth.getSession(c.req.raw.headers));
			const session = Option.getOrUndefined(found);
			let message: SignInMessage;
			if (!session) message = failed("Sign in to Ponder first, then connect again.");
			else if (query.error) {
				if (query.state) yield* ConnectorStore.ConnectorStore.use((store) => store.takeSignIn(query.state!, session.user.id));
				message = failed(query.error === "access_denied" ? "The sign-in was cancelled. Nothing was saved." : `The server ended the sign-in: ${query.error_description || query.error}`);
			} else if (!query.code || !query.state) message = failed("The sign-in came back without a code. Try again.");
			else {
				const params = { state: query.state, code: query.code, issuer: query.iss };
				message = yield* connectors((service) => service.completeSignIn(session.user.id, params)).pipe(
					Effect.map(({ id }): SignInMessage => ({ type: "ponder:connector-sign-in", ok: true, id })),
					Effect.catchCause((cause): Effect.Effect<SignInMessage> => {
						if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
						const error = Cause.squash(cause);
						return Effect.as(Effect.logWarning("connectors: sign-in:", error), failed(describeError(error)));
					}),
				);
			}
			if (query.state) message.state = query.state;
			return c.html(callbackPage(message), 200, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
		}),
	);
}

const failed = (error: string): SignInMessage => ({ type: "ponder:connector-sign-in", ok: false, error });

function callbackPage(message: SignInMessage) {
	// JSON in a script: "<" is escaped, so no value can close the script tag.
	const data = JSON.stringify(message).replace(/</g, "\\u003c");
	const back = new URLSearchParams({ settings: "connectors", ...(message.id && { connector: message.id }), ...(message.error && { connector_error: message.error }) });
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ponder Chat</title>
<style>body{font:15px system-ui,sans-serif;color:#555;display:grid;place-items:center;height:100vh;margin:0}</style></head>
<body><p>${message.ok ? "Connected. You can close this window." : "The sign-in did not finish. You can close this window."}</p>
<script>
const message = ${data};
// The page that started the sign-in listens on this channel. Some sign-in pages cut a
// popup off from its opener, so the channel works where window.opener does not.
try { new BroadcastChannel("ponder-connectors").postMessage(message); } catch {}
if (window.opener && !window.opener.closed) window.opener.postMessage(message, location.origin);
window.close();
// Still open: the sign-in used this tab (a phone), or the window can't close itself.
setTimeout(() => location.replace("/?" + ${JSON.stringify(back.toString())}), 400);
</script></body></html>`;
}
