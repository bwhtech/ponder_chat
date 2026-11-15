import * as PgClient from "@effect/sql-pg/PgClient";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { SqlError } from "effect/sql/SqlError";
import { Pool } from "pg";
import * as PonderConfig from "../config.ts";
import * as Mailer from "../email/Mailer.ts";
import { isLocalHost } from "../hosts.ts";
import * as Invites from "../people/Invites.ts";
import * as AdminAuthEvents from "./AdminAuthEvents.ts";
import { SessionCache, sessionKey } from "./session-cache.ts";

/**
 * Sign-in: Better Auth with no passwords. One email holds a link and a 6-digit code, and
 * either one signs the person in. The code is there because mail scanners (such as
 * Microsoft Safe Links) can open a link before the person does, which uses it up.
 * People, sessions, links and codes live in Ponder's Postgres. A session is a cookie on
 * Ponder's own domain, cached in the cookie for five minutes so most requests skip the
 * session lookup.
 *
 * The admin plugin gives each person a role ("user" or "admin", see people/Accounts.ts) and
 * refuses a new session to a banned person, by link or by code.
 *
 * BETTER_AUTH_SECRET signs the cookies. PONDER_HOSTS lists the hosts Ponder answers on
 * (comma-separated, such as "chat.example.org"); links in emails use the host the
 * person signed in from.
 *
 * Better Auth is a library with its own pool (5 connections), and it calls Ponder back
 * from outside Effect (its hooks, and the emails it asks for). Those callbacks run on
 * the services of this layer, the runtime's. It is made on first use, not when the
 * runtime is built: a script or a check that never signs anyone in does not open its
 * pool or check its tables. Its pool closes with the runtime.
 */

/**
 * Better Auth refused an endpoint call, such as "You cannot ban yourself": its status and
 * its own message, which the admin pages show. Better Auth's messages are fixed texts
 * that name no person.
 */
export class AuthRefused extends Schema.TaggedError<AuthRefused>()("AuthRefused", {
	status: Schema.Number,
	reason: Schema.String,
}) {
	override get message() {
		return this.reason;
	}
}

const SIGN_IN_EXPIRES_IN = 15 * 60;
const NOT_INVITED = "This email is not invited to Ponder Chat.";

/** What Better Auth calls back, run on the runtime's services. */
type Callbacks = {
	readonly isAllowed: (email: string) => Promise<boolean>;
	readonly applyInvite: (user: { id: string; email: string }) => Promise<void>;
	readonly beforeCall: (ctx: AdminAuthEvents.HookContext) => Promise<void>;
	readonly afterCall: (ctx: AdminAuthEvents.HookContext) => Promise<void>;
	readonly forgetSessions: () => void;
	readonly send: (email: Mailer.Email) => Promise<void>;
	readonly log: (line: string) => Promise<void>;
};

function build(pool: Pool, hosts: ReadonlyArray<string>, secret: string | undefined, run: Callbacks) {
	const auth = betterAuth({
		appName: "Ponder Chat",
		secret,
		database: pool,
		baseURL: { allowedHosts: [...hosts] },
		trustedOrigins: hosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
		// Tailscale Serve, Caddy and the Cloudflare Worker in front pass on the host the person used.
		// Cloudflare names the visitor in cf-connecting-ip; Caddy's x-forwarded-for holds Cloudflare's address.
		advanced: { trustedProxyHeaders: true, ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] } },
		// Better Auth limits only in production by default. On always, with tighter limits on
		// what sends an email or checks a code, per address.
		rateLimit: {
			enabled: true,
			window: 60,
			max: 100,
			customRules: {
				"/sign-in/magic-link": { window: 10 * 60, max: 5 },
				"/email-otp/send-verification-otp": { window: 10 * 60, max: 5 },
				"/sign-in/email-otp": { window: 10 * 60, max: 10 },
				"/magic-link/verify": { window: 10 * 60, max: 10 },
			},
		},
		user: { modelName: "users" },
		account: { modelName: "accounts" },
		verification: { modelName: "verifications" },
		session: {
			modelName: "sessions",
			expiresIn: 30 * 24 * 60 * 60,
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		// Invite-only (people/Invites.ts): no account for an email that was not invited. Throwing, not
		// returning false, gives a clean error: the email-OTP plugin would crash on no user.
		// A new account gets the daily limit its invite set.
		databaseHooks: {
			user: {
				create: {
					before: async (user) => {
						if (!(await run.isAllowed(user.email))) throw new APIError("FORBIDDEN", { code: "NOT_INVITED", message: NOT_INVITED });
					},
					after: async (user) => run.applyInvite(user),
				},
			},
		},
		// Admin endpoints that change something go to the admin activity log (AdminAuthEvents.ts).
		//
		// A link refused after its check, such as for a banned person, would show the error as
		// JSON. Send them back to the sign-in page with its code instead. (Success is a 302,
		// also an APIError.) A Response, not ctx.redirect: that would keep the 403 status.
		hooks: {
			// Ponder uses codes only to sign in. A code of another type gets the usual answer, but
			// none is stored: a stored one would show, when it is checked, that the email has an account.
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type !== "sign-in") return ctx.json({ success: true });
				await run.beforeCall(ctx);
			}),
			after: createAuthMiddleware(async (ctx) => {
				// Anything but a read may change who a session belongs to: sign-in and sign-out, revoked
				// sessions, bans, an admin's edit of a person. The sessions kept in memory are read again.
				if (ctx.path !== "/get-session") run.forgetSessions();
				await run.afterCall(ctx);
				const returned = ctx.context.returned;
				if (ctx.path !== "/magic-link/verify" || !isAPIError(returned) || returned.statusCode < 400) return;
				const code = encodeURIComponent(String(returned.body?.code ?? "failed"));
				return new Response(null, { status: 302, headers: { Location: `/?sign-in=failed&error=${code}` } });
			}),
		},
		// There are no passwords, so the email-OTP routes for passwords and email changes stay off.
		disabledPaths: [
			// The page checks a code only by signing in with it. This route counts wrong codes
			// from a stale read, so parallel requests could guess far more than three times.
			"/email-otp/check-verification-otp",
			"/email-otp/request-password-reset",
			"/email-otp/reset-password",
			"/forget-password/email-otp",
			"/email-otp/request-email-change",
			"/email-otp/change-email",
			"/email-otp/verify-email",
			// Admins see usage, not chats, so impersonation is off. But an admin can change a person's
			// email (update-user), and then sign in with the new address. Each change is recorded in
			// the admin activity log and emailed to the old address (AdminAuthEvents.ts). People
			// join by invite and are banned rather than deleted, and there are no passwords to set.
			"/admin/impersonate-user",
			"/admin/create-user",
			"/admin/remove-user",
			"/admin/set-user-password",
		],
		plugins: [
			magicLink({
				expiresIn: SIGN_IN_EXPIRES_IN,
				// Only invited emails get a link and code. The page looks the same either way.
				sendMagicLink: async ({ email, url }, ctx) => {
					if (!(await run.isAllowed(email))) return run.log(`sign-in: ${email} is not invited; no email sent`);
					await run.send(Mailer.signInEmail(email, await signInCode(email, ctx?.headers), url));
				},
			}),
			emailOTP({
				expiresIn: SIGN_IN_EXPIRES_IN,
				// The page gets its code with the link (above). This sends a code alone, when one is asked for directly.
				sendVerificationOTP: async ({ email, otp, type }) => {
					if (type !== "sign-in") return run.log(`sign-in: no ${type} code is sent`);
					if (!(await run.isAllowed(email))) return run.log(`sign-in: ${email} is not invited; no code sent`);
					await run.send(Mailer.signInEmail(email, otp));
				},
			}),
			admin({ bannedUserMessage: "This account is blocked. Ask the person who invited you." }),
		],
	});

	/**
	 * A new sign-in code for the email. Only the newest code works; it expires with the link.
	 * Better Auth finds its base URL from the request's host, so the headers go along.
	 */
	async function signInCode(email: string, headers?: Headers): Promise<string> {
		return auth.api.createVerificationOTP({ body: { email, type: "sign-in" }, headers });
	}

	return auth;
}

type BetterAuth = ReturnType<typeof build>;
/** Better Auth's endpoints, to call from the server (auth.api). */
export type AuthApi = BetterAuth["api"];
/** A signed-in person's session and user, as Better Auth's getSession gives them. */
export type Session = NonNullable<Awaited<ReturnType<AuthApi["getSession"]>>>;
export type SignedIn = BetterAuth["$Infer"]["Session"]["user"];

export class Auth extends Context.Service<
	Auth,
	{
		/** Better Auth's tables, migrated by Better Auth itself, and the columns and index Ponder adds. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** /api/auth/*: Better Auth answers. */
		readonly handler: (request: Request) => Effect.Effect<Response>;
		/**
		 * The signed-in person's session, or none: the same answer as auth.api.getSession,
		 * kept in memory for a minute (session-cache.ts).
		 */
		readonly session: (headers: Headers) => Effect.Effect<Option.Option<Session>>;
		/** auth.api.getSession itself, read from the database each time. */
		readonly getSession: (headers: Headers) => Effect.Effect<Option.Option<Session>>;
		/** Calls one of Better Auth's endpoints. A refusal (its APIError) is AuthRefused; anything else is a defect. */
		readonly call: <A>(endpoint: (api: AuthApi) => Promise<A>) => Effect.Effect<A, AuthRefused>;
	}
>()("ponder/auth/Auth") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const sql = yield* PgClient.PgClient;
	const invites = yield* Invites.Invites;
	const mailer = yield* Mailer.Mailer;
	const adminAuthEvents = yield* AdminAuthEvents.AdminAuthEvents;
	const scope = yield* Effect.scope;
	// Better Auth calls back from outside Effect: the callbacks run on this layer's services
	// (the runtime's pool, logger and tracer). A failure rejects, and Better Auth answers it as before.
	const run = Effect.runPromiseWith(yield* Effect.context<never>());
	const sessions = new SessionCache<Session>();

	const callbacks: Callbacks = {
		isAllowed: (email) => run(invites.isAllowed(email)),
		applyInvite: (user) => run(invites.applyInvite(user)),
		beforeCall: (ctx) => run(adminAuthEvents.before(ctx)),
		afterCall: (ctx) => run(adminAuthEvents.after(ctx)),
		forgetSessions: () => sessions.clear(),
		send: (email) => run(mailer.send(email)),
		log: (line) => run(Effect.log(line)),
	};

	const open = Effect.acquireRelease(
		Effect.sync(() => new Pool({ connectionString: Option.getOrUndefined(Option.map(config.databaseUrl, Redacted.value)), max: 5 })),
		// The process is stopping (startup.ts): a query still running does not hold it up.
		(pool) => Effect.promise(() => pool.end()).pipe(Effect.timeout(Duration.seconds(3)), Effect.ignore),
	).pipe(
		Effect.map((pool) => build(pool, config.hosts, Option.getOrUndefined(Option.map(config.betterAuthSecret, Redacted.value)), callbacks)),
		Scope.provide(scope),
	);
	const instance = yield* Effect.cached(open);

	const migrate = Effect.gen(function* () {
		const auth = yield* instance;
		const { runMigrations } = yield* Effect.promise(() => getMigrations(auth.options));
		yield* Effect.promise(() => runMigrations());
		// Better Auth adds "role" with no default, so people who signed up before the admin plugin would have none.
		yield* sql`alter table users alter column role set default 'user'`;
		yield* sql`update users set role = 'user' where role is null`;
		// Ponder matches emails without case (invites, /admin, scripts/admin.ts); the unique index on email can't serve lower(email).
		yield* sql`create index if not exists users_email_lower on users (lower(email))`;
	});

	const handler = (request: Request) => Effect.flatMap(instance, (auth) => Effect.promise(() => auth.handler(request)));

	const getSession = (headers: Headers) =>
		Effect.flatMap(instance, (auth) => Effect.promise(() => auth.api.getSession({ headers }))).pipe(Effect.map(Option.fromNullishOr));

	// No span: every /api request and the chat page ask, nearly always from memory.
	const session = Effect.fnUntraced(function* (headers: Headers) {
		// The signed value as it came: only a value that Better Auth checked before is ever found.
		const key = sessionKey(headers);
		const now = yield* Clock.currentTimeMillis;
		const kept = key ? sessions.get(key, now) : undefined;
		if (kept && new Date(kept.session.expiresAt).getTime() > now) return Option.some(kept);
		const found = yield* getSession(headers);
		if (key) sessions.remember(key, Option.getOrUndefined(found), now);
		return found;
	});

	const call = <A>(endpoint: (api: AuthApi) => Promise<A>) =>
		Effect.flatMap(instance, (auth) =>
			Effect.tryPromise({ try: () => endpoint(auth.api), catch: (error) => error }).pipe(
				Effect.catch((error) => (isAPIError(error) ? Effect.fail(new AuthRefused({ status: error.statusCode, reason: error.message })) : Effect.die(error))),
			),
		);

	return Auth.of({ migrate, handler, session, getSession, call });
});

export const layer = Layer.effect(Auth, make);

/**
 * The address people open Ponder at, for links in emails and alerts: the host of this
 * request if it is one of PONDER_HOSTS, else the first of them.
 */
export function originFor(hosts: ReadonlyArray<string>, headers: Headers) {
	const asked = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
	const host = hosts.includes(asked) ? asked : hosts[0];
	const local = isLocalHost(host);
	const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim();
	const proto = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
	return `${proto}://${host}`;
}

/** originFor with the hosts of PonderConfig. */
export const appOrigin = (headers: Headers) => PonderConfig.PonderConfig.useSync((config) => originFor(config.hosts, headers));
