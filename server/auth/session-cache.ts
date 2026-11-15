/**
 * Who a session cookie belongs to, kept in memory for a minute: every /api request and the
 * chat page ask (app.ts, boot-page.ts), and Better Auth reads the session and its person
 * from Postgres each time. Its own cache (session.cookieCache in Auth.ts) never reaches the
 * browser here, since the check runs through auth.api and its Set-Cookie goes nowhere.
 *
 * This cache cannot make a revoked session live on, as a cookie would for five minutes:
 * every change goes through Better Auth in this process (sign-out, revoked sessions, bans,
 * an admin's edit of a person), and its hooks empty the cache (Auth.ts). Ponder runs one
 * server process (startup.ts). A session that ends by its date is checked too (Auth.ts).
 * The role is not taken from here: it is read from the database (people/Accounts.ts).
 *
 * Plain code: Auth.ts gives it the time.
 */
const KEEP_MS = 60_000;
/** Enough for every device of a small group; past it the oldest go first. */
const MAX_SESSIONS = 1000;

/** The signed session cookie, under its plain or its __Secure- name. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/;

/** The key a request's session is kept under: its signed cookie, as it came. */
export function sessionKey(headers: Headers): string | undefined {
	return SESSION_COOKIE.exec(headers.get("cookie") ?? "")?.[1];
}

export class SessionCache<Session> {
	private sessions = new Map<string, { session: Session; until: number }>();

	/** The session kept for this key, if it was kept less than a minute before `now`. */
	get(key: string, now: number): Session | undefined {
		const kept = this.sessions.get(key);
		return kept && kept.until > now ? kept.session : undefined;
	}

	/** Keeps the session that Better Auth found for the key; none forgets it. */
	remember(key: string, session: Session | undefined, now: number) {
		this.sessions.delete(key);
		if (!session) return;
		if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
		this.sessions.set(key, { session, until: now + KEEP_MS });
	}

	/** Called after Better Auth changes anything (Auth.ts): every session is read again. */
	clear() {
		this.sessions.clear();
	}
}
