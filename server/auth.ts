import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { Pool } from "pg";
import { sql } from "./db.ts";
import { sendEmail, signInEmail } from "./email.ts";
import { applyInvite, isAllowed } from "./invites.ts";

/**
 * Sign-in: Better Auth with no passwords. One email holds a link and a 6-digit code, and
 * either one signs the person in. The code is there because mail scanners (such as
 * Microsoft Safe Links) can open a link before the person does, which uses it up.
 * People, sessions, links and codes live in Ponder's Postgres. A session is a cookie on
 * Ponder's own domain, cached in the cookie for five minutes so most requests skip the
 * session lookup.
 *
 * The admin plugin gives each person a role ("user" or "admin", see admins.ts) and
 * refuses a new session to a banned person, by link or by code.
 *
 * BETTER_AUTH_SECRET signs the cookies. PONDER_HOSTS lists the hosts Ponder answers on
 * (comma-separated, such as "chat.example.org"); links in emails use the host the
 * person signed in from.
 */
const hosts = (process.env.PONDER_HOSTS ?? `localhost:${process.env.PORT ?? 3500},127.0.0.1:${process.env.PORT ?? 3500}`)
	.split(",")
	.map((host) => host.trim())
	.filter(Boolean);

const SIGN_IN_EXPIRES_IN = 15 * 60;
const NOT_INVITED = "This email is not invited to Ponder Chat.";

export const auth = betterAuth({
	appName: "Ponder Chat",
	database: new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
	baseURL: { allowedHosts: hosts },
	trustedOrigins: hosts.flatMap((host) => [`https://${host}`, `http://${host}`]),
	// Tailscale Serve, Caddy and the Cloudflare Worker in front pass on the host the person used.
	advanced: { trustedProxyHeaders: true },
	user: { modelName: "users" },
	account: { modelName: "accounts" },
	verification: { modelName: "verifications" },
	session: {
		modelName: "sessions",
		expiresIn: 30 * 24 * 60 * 60,
		cookieCache: { enabled: true, maxAge: 5 * 60 },
	},
	// Invite-only (invites.ts): no account for an email that was not invited. Throwing, not
	// returning false, gives a clean error: the email-OTP plugin would crash on no user.
	// A new account gets the daily limit its invite set.
	databaseHooks: {
		user: {
			create: {
				before: async (user) => {
					if (!(await isAllowed(user.email))) throw new APIError("FORBIDDEN", { code: "NOT_INVITED", message: NOT_INVITED });
				},
				after: async (user) => applyInvite(user),
			},
		},
	},
	// A link refused after its check, such as for a banned person, would show the error as
	// JSON. Send them back to the sign-in page with its code instead. (Success is a 302,
	// also an APIError.) A Response, not ctx.redirect: that would keep the 403 status.
	hooks: {
		after: createAuthMiddleware(async (ctx) => {
			const returned = ctx.context.returned;
			if (ctx.path !== "/magic-link/verify" || !isAPIError(returned) || returned.statusCode < 400) return;
			const code = encodeURIComponent(String(returned.body?.code ?? "failed"));
			return new Response(null, { status: 302, headers: { Location: `/?sign-in=failed&error=${code}` } });
		}),
	},
	// There are no passwords, so the email-OTP routes for passwords and email changes stay off.
	disabledPaths: [
		"/email-otp/request-password-reset",
		"/email-otp/reset-password",
		"/forget-password/email-otp",
		"/email-otp/request-email-change",
		"/email-otp/change-email",
		"/email-otp/verify-email",
		// Admins see usage, not chats, so they cannot sign in as someone else. People join by
		// invite and are banned rather than deleted, and there are no passwords to set.
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
				if (!(await isAllowed(email))) return console.log(`sign-in: ${email} is not invited; no email sent`);
				await sendEmail(signInEmail(email, await signInCode(email, ctx?.headers), url));
			},
		}),
		emailOTP({
			expiresIn: SIGN_IN_EXPIRES_IN,
			// The page gets its code with the link (above). This sends a code alone, when one is asked for directly.
			sendVerificationOTP: async ({ email, otp, type }) => {
				if (type !== "sign-in") return console.log(`sign-in: no ${type} code is sent`);
				if (!(await isAllowed(email))) return console.log(`sign-in: ${email} is not invited; no code sent`);
				await sendEmail(signInEmail(email, otp));
			},
		}),
		admin({ bannedUserMessage: "This account is blocked. Ask the person who invited you." }),
	],
});

export type SignedIn = typeof auth.$Infer.Session.user;

export async function migrateAuth() {
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
	// Better Auth adds "role" with no default, so people who signed up before the admin plugin would have none.
	await sql`alter table users alter column role set default 'user'`;
	await sql`update users set role = 'user' where role is null`;
}

/**
 * The address people open Ponder at, for links in emails and alerts: the host of this
 * request if it is one of PONDER_HOSTS, else the first of them.
 */
export function appOrigin(headers: Headers) {
	const asked = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim();
	const host = hosts.includes(asked) ? asked : hosts[0];
	const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
	const forwarded = headers.get("x-forwarded-proto")?.split(",")[0].trim();
	const proto = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
	return `${proto}://${host}`;
}

/**
 * A new sign-in code for the email. Only the newest code works; it expires with the link.
 * Better Auth finds its base URL from the request's host, so the headers go along.
 */
async function signInCode(email: string, headers?: Headers): Promise<string> {
	return auth.api.createVerificationOTP({ body: { email, type: "sign-in" }, headers });
}
