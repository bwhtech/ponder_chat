import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { magicLink } from "better-auth/plugins/magic-link";
import { Pool } from "pg";
import { sendEmail, signInEmail } from "./email.ts";
import { isAllowed } from "./invites.ts";

/**
 * Sign-in: Better Auth with magic links only (no passwords). People, sessions and links
 * live in Seva's Postgres. A session is a cookie on Seva's own domain, cached in the
 * cookie for five minutes so most requests skip the session lookup.
 *
 * BETTER_AUTH_SECRET signs the cookies. SEVA_HOSTS lists the hosts Seva answers on
 * (comma-separated, such as "seva.example.org"); links in emails use the host the
 * person signed in from.
 */
const hosts = (process.env.SEVA_HOSTS ?? `localhost:${process.env.PORT ?? 3500},127.0.0.1:${process.env.PORT ?? 3500}`)
	.split(",")
	.map((host) => host.trim())
	.filter(Boolean);

export const auth = betterAuth({
	appName: "Seva Chat",
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
	// Invite-only (invites.ts): no account for an email that was not invited.
	databaseHooks: {
		user: { create: { before: async (user) => ((await isAllowed(user.email)) ? undefined : false) } },
	},
	plugins: [
		magicLink({
			expiresIn: 15 * 60,
			// Only invited emails get a link. The page looks the same either way.
			sendMagicLink: async ({ email, url }) => {
				if (!(await isAllowed(email))) return console.log(`sign-in: ${email} is not invited; no link sent`);
				await sendEmail(signInEmail(email, url));
			},
		}),
	],
});

export type SignedIn = typeof auth.$Infer.Session.user;

export async function migrateAuth() {
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
}
