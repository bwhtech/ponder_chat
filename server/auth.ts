import type { SignedIn } from "./auth/Auth.ts";

/**
 * Sign-in is Better Auth, in auth/Auth.ts. This is the type of the Hono apps behind the
 * session check in app.ts: `c.get("user")` is the signed-in person.
 */
export type SignedInEnv = { Variables: { user: SignedIn } };
