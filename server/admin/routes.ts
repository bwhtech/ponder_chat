import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { requireAdmin } from "../admins.ts";
import { appOrigin, auth, type SignedIn } from "../auth.ts";
import { setDailyCredits } from "../credits.ts";
import { sql } from "../db.ts";
import { creditAnswerEmail, inviteEmail, sendEmail } from "../email.ts";
import { decideRequest, grantCredits, pendingCount, type Decision } from "../extra-credits.ts";
import { allow, disallow, setInviteCredits } from "../invites.ts";
import { checkOpenRouterKey, openRouterKeyStatus, saveOpenRouterKey } from "../openrouter-key.ts";
import { getSettings, updateSettings } from "../settings.ts";
import { listAdmins, listPeople, personDetail } from "./people.ts";
import { overview, requestsReport } from "./reports.ts";

/**
 * The API behind /admin, mounted at /api/admin. Every route needs an admin (requireAdmin).
 * It returns usage numbers only: no route reads messages or thread titles.
 *
 * Role, ban and sign-out go through Better Auth's admin plugin (auth.api), which checks
 * the admin's session again and ends a banned person's sessions.
 */
type Env = { Variables: { user: SignedIn } };

export const adminApi = new Hono<Env>();
adminApi.use("*", requireAdmin);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const credits = z.number().int().min(0).max(1_000_000);
const adminOf = (c: Context<Env>) => c.get("user").id;

// For the sidebar's counts.
adminApi.get("/summary", async (c) => {
	const [[invites], pendingRequests] = await Promise.all([
		sql<{ count: number }[]>`
			select count(*)::int as count from allowed_emails a where not exists (select 1 from users u where lower(u.email) = a.email)`,
		pendingCount(),
	]);
	return c.json({ pendingRequests, invited: invites.count });
});

adminApi.get("/overview", async (c) => {
	const days = [7, 14, 30].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 14;
	return c.json(await overview(days));
});

// People

adminApi.get("/people", async (c) => c.json({ people: await listPeople(), settings: await getSettings() }));

adminApi.get("/people/:id", async (c) => {
	const detail = await personDetail(c.req.param("id"));
	return detail ? c.json({ ...detail, settings: await getSettings() }) : c.json({ error: "No one here." }, 404);
});

// An invited person's id is their email: the limit then waits in the invite (invites.ts).
adminApi.put("/people/:id/daily-credits", async (c) => {
	const input = await readBody(c, z.object({ credits: credits.nullable() }));
	if (!input) return invalid(c);
	const id = c.req.param("id");
	if (id.includes("@")) return (await setInviteCredits(id, input.credits)) ? c.json({ ok: true }) : notFound(c);
	if (!(await hasAccount(id))) return notFound(c);
	await setDailyCredits(id, input.credits);
	return c.json({ ok: true });
});

adminApi.post("/people/:id/grant", async (c) => {
	const input = await readBody(c, z.object({ credits: credits.min(1) }));
	if (!input) return invalid(c);
	if (!(await hasAccount(c.req.param("id")))) return notFound(c);
	await grantCredits(c.req.param("id"), input.credits, adminOf(c));
	return c.json({ ok: true });
});

adminApi.put("/people/:id/role", async (c) => {
	const input = await readBody(c, z.object({ role: z.enum(["admin", "user"]) }));
	if (!input) return invalid(c);
	const userId = c.req.param("id");
	if (input.role === "user" && (await listAdmins()).every((admin) => admin.id === userId)) {
		return c.json({ error: "Ponder Chat needs at least one admin." }, 400);
	}
	return viaAuth(c, () => auth.api.setRole({ body: { userId, role: input.role }, headers: c.req.raw.headers }));
});

adminApi.post("/people/:id/sign-out", (c) =>
	viaAuth(c, () => auth.api.revokeUserSessions({ body: { userId: c.req.param("id") }, headers: c.req.raw.headers })),
);

adminApi.post("/people/:id/ban", async (c) => {
	const input = await readBody(c, z.object({ reason: z.string().trim().max(500).default(""), days: z.number().int().min(1).max(3650).nullable() }));
	if (!input) return invalid(c);
	const body = { userId: c.req.param("id"), banReason: input.reason || undefined, banExpiresIn: input.days ? input.days * 86_400 : undefined };
	return viaAuth(c, () => auth.api.banUser({ body, headers: c.req.raw.headers }));
});

adminApi.post("/people/:id/unban", (c) =>
	viaAuth(c, () => auth.api.unbanUser({ body: { userId: c.req.param("id") }, headers: c.req.raw.headers })),
);

// Invites

const inviteBody = z.object({
	emails: z.array(z.string().trim().toLowerCase().regex(EMAIL)).min(1).max(100),
	note: z.string().trim().max(200).default(""),
	dailyCredits: credits.nullable().default(null),
	sendEmail: z.boolean().default(false),
});

adminApi.post("/invites", async (c) => {
	const input = await readBody(c, inviteBody);
	if (!input) return invalid(c);
	const emails = [...new Set(input.emails)];
	const taken = await sql<{ email: string }[]>`
		select email from allowed_emails where email in ${sql(emails)}
		union select lower(email) from users where lower(email) in ${sql(emails)}`;
	if (taken.length) return c.json({ error: `Already invited: ${taken.map((row) => row.email).join(", ")}` }, 409);
	for (const email of emails) await allow(email, { note: input.note, invitedBy: adminOf(c), dailyCredits: input.dailyCredits });
	const notSent = input.sendEmail ? await emailInvites(c, emails) : [];
	return c.json({ invited: emails.length, notSent });
});

adminApi.post("/invites/:email/send", async (c) => {
	const email = c.req.param("email").toLowerCase();
	const [invite] = await sql`select 1 from allowed_emails where email = ${email}`;
	if (!invite) return notFound(c);
	const notSent = await emailInvites(c, [email]);
	return notSent.length ? c.json({ error: "The email could not be sent." }, 502) : c.json({ ok: true });
});

adminApi.delete("/invites/:email", async (c) => {
	const email = c.req.param("email").toLowerCase();
	if (await hasAccount(email)) return c.json({ error: "They have signed in already. Ban them instead." }, 409);
	return (await disallow(email)) ? c.json({ ok: true }) : notFound(c);
});

// Settings

adminApi.get("/settings", async (c) =>
	c.json({ ...(await getSettings()), admins: await listAdmins(), openRouterKey: await openRouterKeyStatus() }),
);

adminApi.put("/settings", async (c) => {
	const input = await readBody(c, z.object({ defaultDailyCredits: credits, creditsPerUsd: z.number().int().min(1).max(1_000_000_000) }));
	if (!input) return invalid(c);
	await updateSettings(input, adminOf(c));
	return c.json(await getSettings());
});

// Saved encrypted (secrets.ts), and only after OpenRouter accepts it: a wrong key would stop every reply.
adminApi.put("/settings/openrouter-key", async (c) => {
	const input = await readBody(c, z.object({ key: z.string().trim().min(20).max(500) }));
	if (!input) return c.json({ error: "Paste the whole key." }, 400);
	const problem = await checkOpenRouterKey(input.key);
	if (problem) return c.json({ error: problem }, 400);
	await saveOpenRouterKey(input.key, adminOf(c));
	return c.json(await openRouterKeyStatus());
});

// Requests for more credits (extra-credits.ts)

adminApi.get("/requests", async (c) => c.json(await requestsReport()));

adminApi.post("/requests/:id/approve", async (c) => {
	const input = await readBody(c, z.object({ credits: credits.min(1) }));
	return input ? answer(c, { status: "approved", credits: input.credits }) : invalid(c);
});

adminApi.post("/requests/:id/decline", (c) => answer(c, { status: "declined" }));

/** Records the answer, then emails the person. A failed email does not undo the answer. */
async function answer(c: Context<Env>, decision: Decision) {
	const id = Number(c.req.param("id"));
	if (!Number.isSafeInteger(id)) return notFound(c);
	const userId = await decideRequest(id, decision, adminOf(c));
	if (!userId) return c.json({ error: "This request was answered already." }, 409);
	const [person] = await sql<{ email: string }[]>`select email from users where id = ${userId}`;
	const granted = decision.status === "approved" ? decision.credits : null;
	if (person) await sendEmail(creditAnswerEmail(person.email, appOrigin(c.req.raw.headers), granted)).catch(logEmailError);
	return c.json({ ok: true });
}

/** Sends the invite emails. Returns the addresses that could not be sent to. */
async function emailInvites(c: Context<Env>, emails: string[]) {
	const notSent: string[] = [];
	for (const email of emails) {
		await sendEmail(inviteEmail(email, appOrigin(c.req.raw.headers))).catch((error) => {
			logEmailError(error);
			notSent.push(email);
		});
	}
	return notSent;
}

/** Runs a Better Auth admin endpoint and passes on its refusal, such as "You cannot ban yourself". */
async function viaAuth(c: Context<Env>, call: () => Promise<unknown>) {
	try {
		await call();
		return c.json({ ok: true });
	} catch (error) {
		if (isAPIError(error)) return c.json({ error: error.message }, error.statusCode as ContentfulStatusCode);
		throw error;
	}
}

async function readBody<T>(c: Context<Env>, schema: z.ZodType<T>): Promise<T | null> {
	const parsed = schema.safeParse(await c.req.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

/** By user id, or by email. */
async function hasAccount(idOrEmail: string) {
	const [row] = await sql`select 1 from users where id = ${idOrEmail} or lower(email) = ${idOrEmail.toLowerCase()}`;
	return Boolean(row);
}

function invalid(c: Context<Env>) {
	return c.json({ error: "Check the values and try again." }, 400);
}

function notFound(c: Context<Env>) {
	return c.json({ error: "No one here." }, 404);
}

function logEmailError(error: unknown) {
	console.error("email:", error instanceof Error ? error.message : error);
}
