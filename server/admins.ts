import type { MiddlewareHandler } from "hono";
import type { SignedIn } from "./auth.ts";
import { sql } from "./db.ts";

/**
 * Admins: people whose role is "admin". The role is a column of `users` from Better
 * Auth's admin plugin (auth.ts); everyone else is "user". scripts/admin.ts grants and
 * revokes it straight in the database, because a terminal has no admin session.
 */
export type Role = "admin" | "user";

/**
 * Guards /api/admin/* (admin/routes.ts): 403 unless the signed-in person is an admin. It
 * reads the role from the database, because the session in the cookie can be five minutes old.
 */
export const requireAdmin: MiddlewareHandler<{ Variables: { user: SignedIn } }> = async (c, next) => {
	if (!(await isAdmin(c.get("user").id))) return c.json({ error: "Only admins can do this." }, 403);
	await next();
};

export async function isAdmin(userId: string) {
	return (await roleOf(userId)) === "admin";
}

/** Better Auth keeps several roles as "admin,user", so "admin" wins if it is one of them. */
export async function roleOf(userId: string): Promise<Role> {
	const [row] = await sql<{ role: string | null }[]>`select role from users where id = ${userId}`;
	return (row?.role ?? "").split(",").some((role) => role.trim() === "admin") ? "admin" : "user";
}

/** False when the email has no account yet. */
export async function setRole(email: string, role: Role) {
	const rows = await sql`update users set role = ${role}, "updatedAt" = now() where lower(email) = ${email.trim().toLowerCase()} returning id`;
	return rows.length > 0;
}

export async function listAdmins() {
	return sql<{ email: string; role: string; created_at: Date }[]>`
		select email, role, "createdAt" as created_at from users
		where 'admin' = any(string_to_array(replace(role, ' ', ''), ','))
		order by "createdAt"`;
}
