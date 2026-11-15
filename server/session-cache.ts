import { auth } from "./auth.ts";

/**
 * Who a session cookie belongs to, kept in memory for a minute: every /api request and the
 * chat page ask (app.ts, boot-page.ts), and Better Auth reads the session and its person
 * from Postgres each time. Its own cache (session.cookieCache in auth.ts) never reaches the
 * browser here, since the check runs through auth.api and its Set-Cookie goes nowhere.
 *
 * This cache cannot make a revoked session live on, as a cookie would for five minutes:
 * every change goes through Better Auth in this process (sign-out, revoked sessions, bans,
 * an admin's edit of a person), and its hooks empty the cache (forgetSessions, auth.ts).
 * Ponder runs one server process (startup.ts). A session that ends by its date is checked
 * here too. The role is not taken from here: it is read from the database (admins.ts).
 */
type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

const KEEP_MS = 60_000;
/** Enough for every device of a small group; past it the oldest go first. */
const MAX_SESSIONS = 1000;
const sessions = new Map<string, { session: Session; until: number }>();

/** The signed session cookie, under its plain or its __Secure- name. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/;

/** The signed-in person's session, or null. The same answer as auth.api.getSession. */
export async function sessionOf(headers: Headers): Promise<Session | null> {
	// The signed value as it came: only a value that Better Auth checked before is ever found.
	const key = SESSION_COOKIE.exec(headers.get("cookie") ?? "")?.[1];
	const now = Date.now();
	const kept = key ? sessions.get(key) : undefined;
	if (kept && kept.until > now && new Date(kept.session.session.expiresAt).getTime() > now) return kept.session;
	const session = await auth.api.getSession({ headers });
	if (key) remember(key, session, now);
	return session;
}

/** Called after Better Auth changes anything (auth.ts): every session is read again. */
export function forgetSessions() {
	sessions.clear();
}

function remember(key: string, session: Session | null, now: number) {
	sessions.delete(key);
	if (!session) return;
	if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
	sessions.set(key, { session, until: now + KEEP_MS });
}
