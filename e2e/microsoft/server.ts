import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * A stand-in for Microsoft's sign-in (login.microsoftonline.com), for the tests of "Sign in
 * with Microsoft" (server/auth/microsoft-sign-in.test.ts, tests/microsoft-sign-in.spec.ts).
 * Ponder reaches it through PONDER_MICROSOFT_AUTHORITY.
 *
 * It speaks the three endpoints Ponder uses, for any tenant in the path:
 *
 * - GET /<tenant>/oauth2/v2.0/authorize shows a sign-in page that asks for an email, as
 *   Microsoft's asks for an account. Its form goes to /<tenant>/sign-in, which sends the
 *   browser back to Ponder with a code. A test without a browser asks /<tenant>/sign-in itself.
 * - POST /<tenant>/oauth2/v2.0/token checks the client secret, the redirect URI and the
 *   PKCE verifier, and answers an id_token signed with this server's key (RS256).
 * - GET /<tenant>/discovery/v2.0/keys publishes that key.
 *
 * The person is whoever the email says. Their object id comes from the email, so the same
 * email is the same Microsoft account each time. More fields on the sign-in request make
 * the odd cases: `oid` (another account that shows the same email), `tid` (a token that
 * names another tenant), `no_email=1` (an account with no mailbox: no "email" claim),
 * `email_claim` (a directory entry whose email is not its sign-in name) and `deny=1` (the
 * person cancels).
 */
export const MICROSOFT_CLIENT_SECRET = "fake-microsoft-client-secret-value";

type Pending = { tenant: string; clientId: string; redirectUri: string; challenge: string; claims: Record<string, unknown> };

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_ID = "fake-microsoft-key";

function microsoftApp() {
	const pending = new Map<string, Pending>();
	const app = new Hono();

	app.get("/:tenant/oauth2/v2.0/authorize", (c) => c.html(signInPage(c.req.param("tenant"), new URL(c.req.url).searchParams)));

	app.get("/:tenant/sign-in", (c) => {
		const tenant = c.req.param("tenant");
		const { origin, searchParams: query } = new URL(c.req.url);
		const redirect = new URL(query.get("redirect_uri") ?? "");
		redirect.searchParams.set("state", query.get("state") ?? "");
		if (query.get("deny") === "1") {
			redirect.searchParams.set("error", "access_denied");
			redirect.searchParams.set("error_description", "The person cancelled.");
			return c.redirect(redirect.href);
		}
		const email = (query.get("email") ?? "").trim();
		const code = randomBytes(16).toString("hex");
		const tid = query.get("tid") || tenant;
		const oid = query.get("oid") || objectId(email);
		pending.set(code, {
			tenant,
			clientId: query.get("client_id") ?? "",
			redirectUri: redirect.origin + redirect.pathname,
			challenge: query.get("code_challenge") ?? "",
			claims: {
				iss: `${origin}/${tid}/v2.0`,
				tid,
				oid,
				sub: `sub-${oid}`,
				name: query.get("name") || email.split("@")[0],
				preferred_username: email,
				...(query.get("no_email") === "1" ? {} : { email: query.get("email_claim") || email }),
				ver: "2.0",
			},
		});
		redirect.searchParams.set("code", code);
		return c.redirect(redirect.href);
	});

	app.post("/:tenant/oauth2/v2.0/token", async (c) => {
		const form = new URLSearchParams(await c.req.text());
		const code = form.get("code") ?? "";
		const sent = pending.get(code);
		// A code works once.
		pending.delete(code);
		const basic = /^Basic (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
		const [basicId, basicSecret] = basic ? Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent) : [];
		const clientId = form.get("client_id") ?? basicId;
		const clientSecret = form.get("client_secret") ?? basicSecret;
		if (clientSecret !== MICROSOFT_CLIENT_SECRET) return c.json({ error: "invalid_client", error_description: "The client secret is wrong." }, 401);
		if (!sent || sent.tenant !== c.req.param("tenant") || sent.clientId !== clientId || sent.redirectUri !== form.get("redirect_uri")) return c.json({ error: "invalid_grant" }, 400);
		const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
		if (challenge !== sent.challenge) return c.json({ error: "invalid_grant", error_description: "The PKCE verifier is wrong." }, 400);
		const now = Math.floor(Date.now() / 1000);
		const idToken = sign({ ...sent.claims, aud: clientId, iat: now, nbf: now, exp: now + 3600 });
		return c.json({ token_type: "Bearer", scope: "openid profile email", expires_in: 3600, access_token: `fake-access-${code}`, id_token: idToken });
	});

	app.get("/:tenant/discovery/v2.0/keys", (c) => c.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KEY_ID, use: "sig" }] }));

	return app;
}

/** Starts it on `port`, for the e2e tests (start.ts). */
export function startMicrosoft(port: number) {
	return serve({ fetch: microsoftApp().fetch, port, hostname: "127.0.0.1" });
}

/** Starts it on a free port, for a unit test: its address, and how to stop it. */
export function listenMicrosoft(): Promise<{ url: string; close: () => void }> {
	return new Promise((resolve) => {
		const server = serve({ fetch: microsoftApp().fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) =>
			resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }),
		);
	});
}

/** The same email is the same Microsoft account each time: an object id made from it. */
export function objectId(email: string) {
	const hex = createHash("sha256").update(email.toLowerCase()).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sign(claims: Record<string, unknown>) {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const signed = `${encode({ alg: "RS256", typ: "JWT", kid: KEY_ID })}.${encode(claims)}`;
	return `${signed}.${createSign("RSA-SHA256").update(signed).sign(privateKey).toString("base64url")}`;
}

/** The sign-in page: the authorize request's parameters ride along as hidden fields. */
function signInPage(tenant: string, query: URLSearchParams) {
	const hidden = [...query].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("");
	return `<!doctype html><title>Sign in to your account</title>
<h1>Sign in</h1>
<form method="get" action="/${escape(tenant)}/sign-in">${hidden}
<label>Email <input name="email" type="email" required autofocus></label>
<button type="submit">Next</button>
<button type="submit" name="deny" value="1" formnovalidate>Cancel</button>
</form>`;
}

function escape(text: string) {
	return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
