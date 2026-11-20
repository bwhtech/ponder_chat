/**
 * Sign in with Microsoft, from the first request to the session, on a real Postgres
 * (TEST_DATABASE_URL, vitest.config.ts) and against a stand-in for Microsoft's endpoints
 * (e2e/microsoft/server.ts): Better Auth's own provider, and the rules Ponder adds
 * (microsoft.ts, Auth.ts). The cases follow Frappe's tests for its Social Login Key
 * (frappe/integrations/doctype/social_login_key/test_social_login_key.py), where they apply.
 *
 * The test runs in a schema of its own (search_path), which the last test drops: the
 * users table is Better Auth's, and other test files make a smaller one of their own.
 */
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { listenMicrosoft, MICROSOFT_CLIENT_SECRET, objectId } from "../../e2e/microsoft/server.ts";
import * as AdminEvents from "../admin/AdminEvents.ts";
import * as PonderConfig from "../config.ts";
import * as Mailer from "../email/Mailer.ts";
import * as Invites from "../people/Invites.ts";
import * as Database from "../runtime/Database.ts";
import * as Http from "../runtime/Http.ts";
import * as Secrets from "../secrets/Secrets.ts";
import { jsonBody } from "../test-json.ts";
import * as AdminAuthEvents from "./AdminAuthEvents.ts";
import * as Auth from "./Auth.ts";
import type { MicrosoftSettings } from "./microsoft.ts";
import * as SignInProviders from "./SignInProviders.ts";

const run = Math.random().toString(36).slice(2, 10);
const schema = `test_microsoft_${run}`;
const base = process.env.TEST_DATABASE_URL;
const url = base && `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;

const HOST = "ponder.test";
const ORIGIN = `http://${HOST}`;
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-2222-4333-8444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DOMAIN = `org-${run}.example`;

const microsoft = base ? await listenMicrosoft() : undefined;
afterAll(() => microsoft?.close());

const layer = Auth.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(AdminAuthEvents.layer, SignInProviders.layer)),
	Layer.provideMerge(Layer.mergeAll(Invites.layer, AdminEvents.layer, Secrets.layer, Mailer.layer)),
	Layer.provideMerge(Layer.mergeAll(Database.layer, Http.layer)),
	Layer.provide(
		PonderConfig.layerFromEnv({
			...(url ? { DATABASE_URL: url } : {}),
			BETTER_AUTH_SECRET: "test-secret-for-microsoft-sign-in-0123456789",
			PONDER_HOSTS: HOST,
			PONDER_MICROSOFT_AUTHORITY: microsoft?.url ?? "",
		}),
	),
);

const settings: MicrosoftSettings = { enabled: true, tenantId: TENANT, clientId: CLIENT_ID, signUps: "invited", allowedDomains: [DOMAIN] };
const save = (change: Partial<MicrosoftSettings> = {}, secret: string | undefined = MICROSOFT_CLIENT_SECRET) =>
	SignInProviders.SignInProviders.use((providers) => providers.saveMicrosoft({ ...settings, ...change }, secret, "test-admin"));

/** A browser's cookies: what Better Auth set, sent back with each request. */
type Jar = Map<string, string>;
let visitor = 0;

/** One request to /api/auth, as a browser with these cookies sends it. Each jar is a browser of its own. */
const request = Effect.fn("test.request")(function* (jar: Jar, path: string, init: { method?: string; body?: unknown } = {}) {
	const auth = yield* Auth.Auth;
	const response = yield* auth.handler(
		new Request(`${ORIGIN}${path}`, {
			method: init.method ?? "GET",
			headers: {
				cookie: [...jar].filter(([name]) => name !== "ip").map(([name, value]) => `${name}=${value}`).join("; "),
				origin: ORIGIN,
				// Sign-in's limits are per address: each browser has its own.
				"cf-connecting-ip": jar.get("ip") ?? "203.0.113.1",
				...(init.body ? { "content-type": "application/json" } : {}),
			},
			body: init.body ? JSON.stringify(init.body) : undefined,
		}),
	);
	for (const cookie of response.headers.getSetCookie()) {
		const [pair = ""] = cookie.split(";");
		const [name = "", ...value] = pair.split("=");
		if (/max-age=0/i.test(cookie)) jar.delete(name);
		else jar.set(name, value.join("="));
	}
	return response;
});

const browser = (): Jar => new Map([["ip", `203.0.113.${(visitor++ % 250) + 2}`]]);

/** Asks Ponder to start a sign-in: Microsoft's address for it, as the sign-in page gets it. */
const start = Effect.fn("test.start")(function* (jar: Jar) {
	const response = yield* request(jar, "/api/auth/sign-in/social", {
		method: "POST",
		body: { provider: "microsoft", callbackURL: "/chat/after", errorCallbackURL: "/?sign-in=failed" },
	});
	if (!response.ok) return { status: response.status, url: undefined };
	const { url } = yield* Effect.promise(() => jsonBody<{ url: string }>(response));
	return { status: response.status, url: new URL(url) };
});

/** The person signs in at Microsoft as `email`: the address Microsoft sends their browser back to. */
const atMicrosoft = Effect.fn("test.atMicrosoft")(function* (authorize: URL, email: string, extra: Record<string, string> = {}) {
	const signIn = new URL(authorize.href.replace("/oauth2/v2.0/authorize", "/sign-in"));
	signIn.searchParams.set("email", email);
	for (const [name, value] of Object.entries(extra)) signIn.searchParams.set(name, value);
	const response = yield* Effect.promise(() => fetch(signIn, { redirect: "manual" }));
	return new URL(response.headers.get("location") ?? "");
});

/** Where the browser lands after the callback: the page it asked for, or the sign-in page with an error. */
const land = Effect.fn("test.land")(function* (jar: Jar, callback: URL) {
	const response = yield* request(jar, callback.pathname + callback.search);
	assert.strictEqual(response.status, 302);
	return new URL(response.headers.get("location") ?? "", ORIGIN);
});

/** A whole sign-in as `email`, in a browser of its own unless one is given. */
const signIn = Effect.fn("test.signIn")(function* (email: string, extra: Record<string, string> = {}, jar: Jar = browser()) {
	const { url: authorize } = yield* start(jar);
	if (!authorize) return { jar, landed: new URL("/?sign-in=failed&error=NO_PROVIDER", ORIGIN) };
	return { jar, landed: yield* land(jar, yield* atMicrosoft(authorize, email, extra)) };
});

/** Who the browser is signed in as. */
const signedInAs = Effect.fn("test.signedInAs")(function* (jar: Jar) {
	const response = yield* request(jar, "/api/auth/get-session");
	const session = yield* Effect.promise(() => jsonBody<{ user: { id: string; email: string; name: string; emailVerified: boolean } } | null>(response));
	return session?.user;
});

const errorOf = (landed: URL) => landed.searchParams.get("error");
const person = (name: string) => `${name}-${run}@${DOMAIN}`;

describe.skipIf(!base)("Sign in with Microsoft", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("makes the tables", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`create schema ${sql.literal(schema)}`;
				yield* SignInProviders.SignInProviders.use((providers) => providers.migrate);
				yield* Invites.Invites.use((invites) => invites.migrate);
				yield* AdminEvents.AdminEvents.use((events) => events.migrate);
				// What a new account's invite is applied to (credits/Credits.ts).
				yield* sql`create table credit_limits (user_id text primary key, daily_credits integer not null)`;
				yield* Auth.Auth.use((auth) => auth.migrate);
			}),
		);

		it.effect("has no Microsoft sign-in until an admin sets it up", () =>
			Effect.gen(function* () {
				const { status } = yield* start(browser());
				assert.strictEqual(status, 404);
			}),
		);

		it.effect("sends the person to the tenant's own endpoint, with PKCE and no more scope than who they are", () =>
			Effect.gen(function* () {
				yield* save();
				const { url: authorize } = yield* start(browser());
				assert.strictEqual(authorize?.origin + (authorize?.pathname ?? ""), `${microsoft?.url}/${TENANT}/oauth2/v2.0/authorize`);
				const params = authorize?.searchParams;
				assert.strictEqual(params?.get("client_id"), CLIENT_ID);
				assert.strictEqual(params?.get("redirect_uri"), `${ORIGIN}/api/auth/callback/microsoft`);
				assert.strictEqual(params?.get("response_type"), "code");
				assert.strictEqual(params?.get("code_challenge_method"), "S256");
				assert.isAbove(params?.get("code_challenge")?.length ?? 0, 20);
				assert.isAbove(params?.get("state")?.length ?? 0, 20);
				assert.deepStrictEqual(params?.get("scope")?.split(" ").sort(), ["email", "openid", "profile"]);
			}),
		);

		it.effect("signs an invited person in, and keeps none of Microsoft's tokens", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const ana = person("ana");
				yield* Invites.Invites.use((invites) => invites.allow(ana));
				const { jar, landed } = yield* signIn(ana.toUpperCase(), { name: "Ana Example" });
				assert.strictEqual(landed.pathname, "/chat/after");
				const user = yield* signedInAs(jar);
				// Ponder stores emails in lower case, whatever case Microsoft shows.
				assert.strictEqual(user?.email, ana);
				assert.strictEqual(user?.name, "Ana Example");
				assert.isTrue(user?.emailVerified);
				const accounts = yield* sql<{ accountId: string; accessToken: string | null; idToken: string | null; refreshToken: string | null }>`
					select "accountId", "accessToken", "idToken", "refreshToken" from accounts where "userId" = ${user?.id ?? ""} and "providerId" = 'microsoft'`;
				assert.deepStrictEqual(accounts, [{ accountId: objectId(ana), accessToken: null, idToken: null, refreshToken: null }]);
			}),
		);

		it.effect("signs the same person in again, and still keeps no tokens", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const ana = person("ana");
				const { jar, landed } = yield* signIn(ana);
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.email, ana);
				const accounts = yield* sql<{ accessToken: string | null; idToken: string | null }>`
					select a."accessToken", a."idToken" from accounts a join users u on u.id = a."userId" where u.email = ${ana}`;
				assert.deepStrictEqual(accounts, [{ accessToken: null, idToken: null }]);
			}),
		);

		it.effect("refuses another Microsoft account that shows the same email", () =>
			Effect.gen(function* () {
				// frappe/frappe#42500: the email checks out, but it is not the account that was linked.
				const { jar, landed } = yield* signIn(person("ana"), { oid: "00000000-0000-4000-8000-00000000beef" });
				assert.strictEqual(errorOf(landed), "LINKED_TO_ANOTHER_ACCOUNT");
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("links the new Microsoft account once an admin unlinks the old one", () =>
			Effect.gen(function* () {
				// The directory made the person's account again: same email, another id.
				const sql = yield* PgClient.PgClient;
				const providers = yield* SignInProviders.SignInProviders;
				const ana = person("ana");
				const [{ id } = { id: "" }] = yield* sql<{ id: string }>`select id from users where email = ${ana}`;
				const again = { oid: "00000000-0000-4000-8000-0000000000a2" };
				assert.strictEqual(errorOf((yield* signIn(ana, again)).landed), "LINKED_TO_ANOTHER_ACCOUNT");
				assert.isTrue(yield* providers.unlink(id));
				const { jar, landed } = yield* signIn(ana, again);
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.id, id);
				// And now the first account is the other one.
				assert.strictEqual(errorOf((yield* signIn(ana)).landed), "LINKED_TO_ANOTHER_ACCOUNT");
				// Back to the first, for the tests below.
				yield* providers.unlink(id);
				assert.strictEqual((yield* signIn(ana)).landed.pathname, "/chat/after");
			}),
		);

		it.effect("keeps one account of a provider for a person, and one person for an account, in the database too", () =>
			Effect.gen(function* () {
				// Two sign-ins at the same moment both pass the hook's check: the indexes stop the second.
				const sql = yield* PgClient.PgClient;
				const ana = person("ana");
				const [{ id } = { id: "" }] = yield* sql<{ id: string }>`select id from users where email = ${ana}`;
				const insert = (userId: string, accountId: string) =>
					sql`insert into accounts (id, "userId", "providerId", "accountId", "createdAt", "updatedAt") values (${`dup-${accountId}-${userId}`}, ${userId}, 'microsoft', ${accountId}, now(), now())`;
				assert.strictEqual((yield* Effect.flip(insert(id, "another-oid")))._tag, "SqlError");
				assert.strictEqual((yield* Effect.flip(insert(`bo-${run}`, objectId(ana))))._tag, "SqlError");
			}),
		);

		it.effect("lets a whole office, behind one address, start signing in at once", () =>
			Effect.gen(function* () {
				const office = browser();
				for (let people = 0; people < 12; people++) {
					const jar: Jar = new Map([["ip", office.get("ip") ?? ""]]);
					assert.strictEqual((yield* start(jar)).status, 200);
				}
			}),
		);

		it.effect("links the first Microsoft sign-in to the account a person made by email", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const bo = person("bo");
				yield* sql`insert into users (id, name, email, "emailVerified", role, "createdAt", "updatedAt") values (${`bo-${run}`}, 'Bo', ${bo}, true, 'user', now(), now())`;
				const { jar, landed } = yield* signIn(bo);
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.id, `bo-${run}`);
			}),
		);

		it.effect("makes no account for a person who was not invited", () =>
			Effect.gen(function* () {
				const { jar, landed } = yield* signIn(person("stranger"));
				assert.strictEqual(landed.pathname, "/");
				assert.strictEqual(landed.searchParams.get("sign-in"), "failed");
				assert.strictEqual(errorOf(landed), "NOT_INVITED");
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("makes an account for everyone of the tenant, once an admin says so", () =>
			Effect.gen(function* () {
				yield* save({ signUps: "everyone" }, undefined);
				const cy = person("cy");
				const { jar, landed } = yield* signIn(cy);
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.email, cy);
				// Not an invite: the person signs in with Microsoft, not by email.
				assert.isFalse(yield* Invites.Invites.use((invites) => invites.isAllowed(cy)));
				yield* save({}, undefined);
			}),
		);

		it.effect("still asks for an invite to sign up by email, when Microsoft takes everyone", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* save({ signUps: "everyone" }, undefined);
				const walkIn = person("walk-in");
				const jar = browser();
				// No email goes to an address that is not invited. The link's token is read here, as if it had.
				yield* request(jar, "/api/auth/sign-in/magic-link", { method: "POST", body: { email: walkIn, callbackURL: "/" } });
				const [link] = yield* sql<{ identifier: string }>`select identifier from verifications where value like ${`%${walkIn}%`}`;
				const response = yield* request(jar, `/api/auth/magic-link/verify?token=${link?.identifier.replace("magic-link:", "")}&callbackURL=/`);
				assert.strictEqual(new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error"), "NOT_INVITED");
				assert.isUndefined(yield* signedInAs(jar));
				yield* save({}, undefined);
			}),
		);

		it.effect("refuses an email outside the organisation's domains, even for everyone", () =>
			Effect.gen(function* () {
				yield* save({ signUps: "everyone" }, undefined);
				// A guest of the tenant, or a directory entry that shows someone else's address.
				const outside = yield* signIn(`guest-${run}@elsewhere.example`);
				assert.strictEqual(errorOf(outside.landed), "EMAIL_DOMAIN_NOT_ALLOWED");
				assert.isUndefined(yield* signedInAs(outside.jar));
				const shown = yield* signIn(person("dee"), { email_claim: `victim-${run}@elsewhere.example` });
				assert.strictEqual(errorOf(shown.landed), "EMAIL_DOMAIN_NOT_ALLOWED");
				yield* save({}, undefined);
			}),
		);

		it.effect("does not open someone's Ponder account to a directory entry that shows their address", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const outsider = `owner-${run}@elsewhere.example`;
				yield* sql`insert into users (id, name, email, "emailVerified", role, "createdAt", "updatedAt") values (${`owner-${run}`}, 'Owner', ${outsider}, true, 'admin', now(), now())`;
				const { jar, landed } = yield* signIn(person("eve"), { email_claim: outsider });
				assert.strictEqual(errorOf(landed), "EMAIL_DOMAIN_NOT_ALLOWED");
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("reads the sign-in name of an account with no mailbox as its email", () =>
			Effect.gen(function* () {
				const fay = person("fay");
				yield* Invites.Invites.use((invites) => invites.allow(fay));
				const { jar, landed } = yield* signIn(fay, { no_email: "1" });
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.email, fay);
			}),
		);

		it.effect("refuses a token that names another tenant", () =>
			Effect.gen(function* () {
				const gil = person("gil");
				yield* Invites.Invites.use((invites) => invites.allow(gil));
				const { jar, landed } = yield* signIn(gil, { tid: OTHER_TENANT });
				assert.strictEqual(errorOf(landed), "WRONG_TENANT");
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("refuses a banned person", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const ana = person("ana");
				yield* sql`update users set banned = true where email = ${ana}`;
				const { jar, landed } = yield* signIn(ana);
				assert.strictEqual(errorOf(landed), "BANNED_USER");
				assert.isUndefined(yield* signedInAs(jar));
				yield* sql`update users set banned = false where email = ${ana}`;
			}),
		);

		it.effect("comes back to the sign-in page when the person cancels at Microsoft", () =>
			Effect.gen(function* () {
				const { jar, landed } = yield* signIn(person("ana"), { deny: "1" });
				assert.strictEqual(landed.pathname, "/");
				assert.strictEqual(errorOf(landed), "access_denied");
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("signs no one in for a state it did not make", () =>
			Effect.gen(function* () {
				const jar = browser();
				const { url: authorize } = yield* start(jar);
				assert.isDefined(authorize);
				if (!authorize) return;
				const callback = yield* atMicrosoft(authorize, person("ana"));
				callback.searchParams.set("state", "attacker-forged-state");
				const landed = yield* land(jar, callback);
				assert.strictEqual(landed.searchParams.get("sign-in"), "failed");
				assert.isNotNull(errorOf(landed));
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("takes a callback only from the browser that started the sign-in", () =>
			Effect.gen(function* () {
				// An attacker starts a sign-in, signs in at Microsoft as themselves, and gets a victim's
				// browser to open the callback: the victim would use the attacker's account without knowing.
				const attacker = browser();
				const { url: authorize } = yield* start(attacker);
				assert.isDefined(authorize);
				if (!authorize) return;
				const callback = yield* atMicrosoft(authorize, person("ana"));
				const victim = browser();
				const landed = yield* land(victim, callback);
				assert.strictEqual(landed.searchParams.get("sign-in"), "failed");
				assert.isUndefined(yield* signedInAs(victim));
			}),
		);

		it.effect("takes a callback once", () =>
			Effect.gen(function* () {
				const jar = browser();
				const { url: authorize } = yield* start(jar);
				assert.isDefined(authorize);
				if (!authorize) return;
				const callback = yield* atMicrosoft(authorize, person("ana"));
				assert.strictEqual((yield* land(jar, callback)).pathname, "/chat/after");
				// The same address again, in a browser that kept the first one's cookies but is signed out.
				const replay: Jar = new Map([...jar].filter(([name]) => !name.includes("session")));
				const landed = yield* land(replay, callback);
				assert.strictEqual(landed.searchParams.get("sign-in"), "failed");
				assert.isUndefined(yield* signedInAs(replay));
			}),
		);

		it.effect("takes no id_token that a page posts: the person signs in at Microsoft, by redirect", () =>
			Effect.gen(function* () {
				const jar = browser();
				const response = yield* request(jar, "/api/auth/sign-in/social", {
					method: "POST",
					body: { provider: "microsoft", idToken: { token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0." } },
				});
				assert.isAtLeast(response.status, 400);
				assert.isUndefined(yield* signedInAs(jar));
			}),
		);

		it.effect("comes back only to Ponder's own pages", () =>
			Effect.gen(function* () {
				for (const callbackURL of ["https://evil.example/", "//evil.example/", "/\\evil.example/"]) {
					const response = yield* request(browser(), "/api/auth/sign-in/social", { method: "POST", body: { provider: "microsoft", callbackURL } });
					assert.strictEqual(response.status, 403, callbackURL);
				}
				const response = yield* request(browser(), "/api/auth/sign-in/social", {
					method: "POST",
					body: { provider: "microsoft", callbackURL: "/", errorCallbackURL: "https://evil.example/" },
				});
				assert.strictEqual(response.status, 403);
			}),
		);

		it.effect("fails the sign-in when the client secret is wrong", () =>
			Effect.gen(function* () {
				yield* save({}, "a-wrong-client-secret-value");
				const { jar, landed } = yield* signIn(person("ana"));
				assert.strictEqual(errorOf(landed), "invalid_code");
				assert.isUndefined(yield* signedInAs(jar));
				yield* save();
			}),
		);

		it.effect("stops at once when an admin turns it off, and keeps the secret for later", () =>
			Effect.gen(function* () {
				const status = yield* save({ enabled: false }, undefined);
				assert.isFalse(status.enabled);
				assert.isTrue(status.hasSecret);
				assert.strictEqual((yield* start(browser())).status, 404);
				// On again without typing the secret again.
				yield* save({}, undefined);
				const { jar, landed } = yield* signIn(person("ana"));
				assert.strictEqual(landed.pathname, "/chat/after");
				assert.strictEqual((yield* signedInAs(jar))?.email, person("ana"));
			}),
		);

		it.effect("leaves sign-in by email as it was", () =>
			Effect.gen(function* () {
				// An email that is not invited gets the usual answer, and no email (Auth.ts).
				const response = yield* request(browser(), "/api/auth/sign-in/magic-link", { method: "POST", body: { email: person("nobody"), callbackURL: "/" } });
				assert.strictEqual(response.status, 200);
			}),
		);

		it.effect("turns sign-in by email off only while Microsoft works, and on again when Microsoft goes off", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				const providers = yield* SignInProviders.SignInProviders;
				const ana = person("ana");
				const magicLink = (jar: Jar, email: string) => request(jar, "/api/auth/sign-in/magic-link", { method: "POST", body: { email, callbackURL: "/" } });
				// A link sent while email was on.
				yield* magicLink(browser(), ana);
				const [link] = yield* sql<{ identifier: string }>`select identifier from verifications where value like ${`%${ana}%`} order by "createdAt" desc limit 1`;
				assert.isDefined(link);

				assert.isFalse(yield* providers.saveEmail(false, "test-admin"));
				assert.isFalse((yield* providers.active).email);
				// No link or code is sent, none is checked, and the link sent before no longer signs in.
				assert.strictEqual((yield* magicLink(browser(), ana)).status, 404);
				assert.strictEqual((yield* request(browser(), "/api/auth/email-otp/send-verification-otp", { method: "POST", body: { email: ana, type: "sign-in" } })).status, 404);
				assert.strictEqual((yield* request(browser(), "/api/auth/sign-in/email-otp", { method: "POST", body: { email: ana, otp: "123456" } })).status, 404);
				const jar = browser();
				yield* request(jar, `/api/auth/magic-link/verify?token=${link?.identifier.replace("magic-link:", "")}&callbackURL=/`);
				assert.isUndefined(yield* signedInAs(jar));
				// Microsoft signs people in as before.
				assert.strictEqual((yield* signIn(ana)).landed.pathname, "/chat/after");

				// Microsoft off: email is the way in again, and its setting says so.
				yield* save({ enabled: false }, undefined);
				assert.isTrue((yield* providers.active).email);
				assert.deepStrictEqual(yield* sql`select enabled from sign_in_providers where id = 'email'`, [{ enabled: true }]);
				assert.strictEqual((yield* magicLink(browser(), person("nobody"))).status, 200);
				// And it can't go off while Microsoft is off: nobody could sign in.
				const refused = yield* Effect.flip(providers.saveEmail(false, "test-admin"));
				assert.strictEqual(refused._tag, "EmailNeeded");
				assert.isTrue((yield* providers.active).email);
			}),
		);

		it.effect("drops the test's schema", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`drop schema ${sql.literal(schema)} cascade`;
			}),
		);
	});
});
