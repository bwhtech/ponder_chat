import { type Context, Hono } from "hono";
import { z } from "zod";
import { appOrigin, auth, type SignedInEnv } from "../auth.ts";
import { connectorLimit, limitPerPerson } from "../rate-limit.ts";
import {
	addConnector,
	changeConnector,
	completeSignIn,
	listConnectors,
	refreshConnector,
	removeConnector,
	signInAgain,
} from "./connectors.ts";
import { ConnectorProblem, describeError, NeedsSignIn } from "./errors.ts";
import { probe } from "./probe.ts";
import { takeSignIn } from "./store.ts";
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
const limited = limitPerPerson(connectorLimit, userOf);

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

export const connectorsApi = new Hono<Env>()
	.get("/", (c) => answer(c, async () => ({ connectors: await listConnectors(userOf(c)) })))

	.post("/probe", limited, validate("json", probeBody), (c) => answer(c, () => probe(c.req.valid("json").url)))

	.post("/", limited, validate("json", newConnector), (c) => answer(c, () => addConnector(userOf(c), appOrigin(c.req.raw.headers), c.req.valid("json"))))

	.post("/:id/sign-in", limited, (c) => answer(c, () => signInAgain(userOf(c), appOrigin(c.req.raw.headers), idOf(c))))

	.post("/:id/refresh", limited, (c) => answer(c, async () => ({ connector: await refreshConnector(userOf(c), idOf(c)) })))

	.patch("/:id", validate("json", change), (c) => answer(c, async () => ({ connector: await changeConnector(userOf(c), idOf(c), c.req.valid("json")) })))

	.delete("/:id", (c) =>
		answer(c, async () => {
			if (!(await removeConnector(userOf(c), idOf(c)))) throw new ConnectorProblem("That connector was not found.");
			return { ok: true };
		}),
	);

/**
 * Runs a request: a problem the person can fix is a 400 with its message. The MCP SDK
 * checks a server's replies with zod, and its message says what the server got wrong.
 */
async function answer<T extends object>(c: Context<Env>, run: () => Promise<T>) {
	try {
		return c.json(await run());
	} catch (error) {
		if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "That request is not valid." }, 400);
		if (error instanceof ConnectorProblem || error instanceof NeedsSignIn) return c.json({ error: error.message }, 400);
		console.warn("connectors:", error);
		return c.json({ error: describeError(error) }, 502);
	}
}

/**
 * GET /oauth/mcp/callback: the end of an OAuth sign-in. The person's session must be the
 * one that started it. The page tells Ponder's other pages (web/connectors/sign-in.ts)
 * and closes; on a phone, where the sign-in used the same tab, it goes back to Settings,
 * Connectors.
 */
export async function oauthCallback(c: Context) {
	const query = c.req.query();
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	let message: SignInMessage;
	if (!session) message = failed("Sign in to Ponder first, then connect again.");
	else if (query.error) {
		if (query.state) await takeSignIn(query.state, session.user.id);
		message = failed(query.error === "access_denied" ? "The sign-in was cancelled. Nothing was saved." : `The server ended the sign-in: ${query.error_description || query.error}`);
	} else if (!query.code || !query.state) message = failed("The sign-in came back without a code. Try again.");
	else {
		try {
			const { id } = await completeSignIn(session.user.id, { state: query.state, code: query.code, issuer: query.iss });
			message = { type: "ponder:connector-sign-in", ok: true, id };
		} catch (error) {
			console.warn("connectors: sign-in:", error);
			message = failed(describeError(error));
		}
	}
	if (query.state) message.state = query.state;
	return c.html(callbackPage(message), 200, { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
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
