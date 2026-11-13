import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { recordAdminEvent, type AdminEvent } from "../admin-events.ts";
import { requireAdmin } from "../admins.ts";
import { appOrigin, auth, type SignedInEnv } from "../auth.ts";
import { setDailyCredits } from "../credits.ts";
import { sql } from "../db.ts";
import { creditAnswerEmail, inviteEmail, sendEmail } from "../email.ts";
import { decideRequest, grantCredits, pendingCount, type Decision } from "../extra-credits.ts";
import { allow, disallow, setInviteCredits } from "../invites.ts";
import { checkOpenRouterKey, openRouterKeyStatus, saveOpenRouterKey } from "../openrouter-key.ts";
import { availableModels } from "../models.ts";
import { getSettings, setCompactionModel, setPdfTextOnServer, updateSettings } from "../settings.ts";
import { MAX_BODY } from "../../shared/skill-file.ts";
import { deleteSkill, getSkill, listSkills, saveSkill, setSkillEnabled, type SaveResult, type SkillDetail } from "../skills.ts";
import { activityPage } from "./activity.ts";
import { listAdmins, listPeople, personDetail } from "./people.ts";
import { overview, requestsReport } from "./reports.ts";
import { validate } from "../validate.ts";

/**
 * The API behind /admin, mounted at /api/admin. Every route needs an admin (requireAdmin).
 * It returns usage numbers only: no route reads messages or thread titles.
 *
 * Role, ban and sign-out go through Better Auth's admin plugin (auth.api), which checks
 * the admin's session again and ends a banned person's sessions.
 *
 * Each change goes to the admin activity log (admin-events.ts) with `record`. The changes
 * made through Better Auth are logged in its hooks (admin-auth-events.ts), so not here.
 */
type Env = SignedInEnv;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const credits = z.number().int().min(0).max(1_000_000);
const adminOf = (c: Context<Env>) => c.get("user").id;

/** A JSON body that fits the schema, or a 400. */
const body = <Schema extends z.ZodType>(schema: Schema) => validate("json", schema, { error: "Check the values and try again." });

const inviteBody = z.object({
	emails: z.array(z.string().trim().toLowerCase().regex(EMAIL)).min(1).max(100),
	note: z.string().trim().max(200).default(""),
	dailyCredits: credits.nullable().default(null),
	sendEmail: z.boolean().default(false),
});

// The server checks the values with the skill rules (shared/skill-file.ts); this only bounds them.
const skillBody = z.object({
	name: z.string().trim().max(200),
	description: z.string().max(2_000),
	automatic: z.boolean().default(true),
	body: z.string().max(MAX_BODY * 2).default(""),
	/** A new skill starts off until it has instructions. */
	enabled: z.boolean().default(false),
	/** When the admin's copy was loaded; absent for a new skill. */
	expectedUpdatedAt: z.string().datetime().optional(),
});

// The overview covers 7, 14 or 30 days; any other value is 14.
const overviewQuery = z.object({ days: z.enum(["7", "14", "30"]).default("14").catch("14").transform(Number) });
// Values that are not ids are ignored, not refused.
const activityQuery = z.object({
	before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
	person: z.string().trim().optional().catch(undefined).transform((person) => person || undefined),
});

export const adminApi = new Hono<Env>()
	.use("*", requireAdmin)

	// For the sidebar's counts.
	.get("/summary", async (c) => {
		const [[invites], pendingRequests] = await Promise.all([
			sql<{ count: number }[]>`
				select count(*)::int as count from allowed_emails a where not exists (select 1 from users u where lower(u.email) = a.email)`,
			pendingCount(),
		]);
		return c.json({ pendingRequests, invited: invites.count });
	})

	.get("/overview", validate("query", overviewQuery), async (c) => c.json(await overview(c.req.valid("query").days)))

	// The admin activity log, newest first. `before` is the last id of the page before; `person` a user id or an invite's email.
	.get("/activity", validate("query", activityQuery), async (c) => {
		const { before, person } = c.req.valid("query");
		return c.json(await activityPage({ olderThan: before, person }));
	})

	// People

	.get("/people", async (c) => c.json({ people: await listPeople(), settings: await getSettings() }))

	.get("/people/:id", async (c) => {
		const detail = await personDetail(c.req.param("id"));
		return detail ? c.json({ ...detail, settings: await getSettings() }) : c.json({ error: "No one here." }, 404);
	})

	// An invited person's id is their email: the limit then waits in the invite (invites.ts).
	.put("/people/:id/daily-credits", body(z.object({ credits: credits.nullable() })), async (c) => {
		const input = c.req.valid("json");
		const id = c.req.param("id");
		const target = id.includes("@") ? id.toLowerCase() : id;
		const before = { dailyCredits: await ownDailyCredits(target) };
		if (!(await saveDailyCredits(target, input.credits))) return notFound(c);
		await record(c, "set-daily-credits", { target, before, after: { dailyCredits: input.credits } });
		return c.json({ ok: true });
	})

	.post("/people/:id/grant", body(z.object({ credits: credits.min(1) })), async (c) => {
		const input = c.req.valid("json");
		const id = c.req.param("id");
		if (!(await hasAccount(id))) return notFound(c);
		await grantCredits(id, input.credits, adminOf(c));
		await record(c, "grant-credits", { target: id, after: { credits: input.credits } });
		return c.json({ ok: true });
	})

	.put("/people/:id/role", body(z.object({ role: z.enum(["admin", "user"]) })), async (c) => {
		const input = c.req.valid("json");
		const userId = c.req.param("id");
		if (input.role === "user" && (await listAdmins()).every((admin) => admin.id === userId)) {
			return c.json({ error: "Ponder Chat needs at least one admin." }, 400);
		}
		return viaAuth(c, () => auth.api.setRole({ body: { userId, role: input.role }, headers: c.req.raw.headers }));
	})

	.post("/people/:id/sign-out", (c) =>
		viaAuth(c, () => auth.api.revokeUserSessions({ body: { userId: c.req.param("id") }, headers: c.req.raw.headers })),
	)

	.post("/people/:id/ban", body(z.object({ reason: z.string().trim().max(500).default(""), days: z.number().int().min(1).max(3650).nullable() })), async (c) => {
		const input = c.req.valid("json");
		const banned = { userId: c.req.param("id"), banReason: input.reason || undefined, banExpiresIn: input.days ? input.days * 86_400 : undefined };
		return viaAuth(c, () => auth.api.banUser({ body: banned, headers: c.req.raw.headers }));
	})

	.post("/people/:id/unban", (c) =>
		viaAuth(c, () => auth.api.unbanUser({ body: { userId: c.req.param("id") }, headers: c.req.raw.headers })),
	)

	// Invites

	.post("/invites", body(inviteBody), async (c) => {
		const input = c.req.valid("json");
		const emails = [...new Set(input.emails)];
		const taken = await sql<{ email: string }[]>`
			select email from allowed_emails where email in ${sql(emails)}
			union select lower(email) from users where lower(email) in ${sql(emails)}`;
		if (taken.length) return c.json({ error: `Already invited: ${taken.map((row) => row.email).join(", ")}` }, 409);
		for (const email of emails) await allow(email, { note: input.note, invitedBy: adminOf(c), dailyCredits: input.dailyCredits });
		const notSent = input.sendEmail ? await emailInvites(c, emails) : [];
		for (const email of emails) {
			const emailed = input.sendEmail && !notSent.includes(email);
			await record(c, "invite", { target: email, after: { note: input.note, dailyCredits: input.dailyCredits, emailed } });
		}
		return c.json({ invited: emails.length, notSent });
	})

	.post("/invites/:email/send", async (c) => {
		const email = c.req.param("email").toLowerCase();
		const [invite] = await sql`select 1 from allowed_emails where email = ${email}`;
		if (!invite) return notFound(c);
		const notSent = await emailInvites(c, [email]);
		if (notSent.length) return c.json({ error: "The email could not be sent." }, 502);
		await record(c, "send-invite", { target: email });
		return c.json({ ok: true });
	})

	.delete("/invites/:email", async (c) => {
		const email = c.req.param("email").toLowerCase();
		if (await hasAccount(email)) return c.json({ error: "They have signed in already. Ban them instead." }, 409);
		if (!(await disallow(email))) return notFound(c);
		await record(c, "remove-invite", { target: email });
		return c.json({ ok: true });
	})

	// Settings

	.get("/settings", async (c) =>
		c.json({
			...(await getSettings()),
			admins: await listAdmins(),
			openRouterKey: await openRouterKeyStatus(),
			// Only models with a private (ZDR) endpoint: another would fall back to the chat's own model.
			models: (await availableModels()).models.map(({ id, name }) => ({ id, name })),
		}),
	)

	.put("/settings", body(z.object({ defaultDailyCredits: credits, creditsPerUsd: z.number().int().min(1).max(1_000_000_000) })), async (c) => {
		const input = c.req.valid("json");
		const { defaultDailyCredits, creditsPerUsd } = await getSettings();
		await updateSettings(input, adminOf(c));
		await record(c, "update-settings", { before: { defaultDailyCredits, creditsPerUsd }, after: input });
		return c.json(await getSettings());
	})

	// How PDFs reach models that can't read them (settings.ts). Saved at once, apart from the credits.
	.put("/settings/pdf-reading", body(z.object({ onServer: z.boolean() })), async (c) => {
		const input = c.req.valid("json");
		const before = { pdfTextOnServer: (await getSettings()).pdfTextOnServer };
		await setPdfTextOnServer(input.onServer, adminOf(c));
		await record(c, "set-pdf-reading", { before, after: { pdfTextOnServer: input.onServer } });
		return c.json(await getSettings());
	})

	// The model that writes a chat's summary when it gets too long (compaction/summarize.ts). A model with a private (ZDR) endpoint.
	.put("/settings/compaction-model", body(z.object({ model: z.string() })), async (c) => {
		const input = c.req.valid("json");
		const { models } = await availableModels();
		if (!models.some((model) => model.id === input.model)) return c.json({ error: "That model has no private endpoint now. Choose another." }, 400);
		const before = { compactionModel: (await getSettings()).compactionModel };
		await setCompactionModel(input.model, adminOf(c));
		await record(c, "set-compaction-model", { before, after: { compactionModel: input.model } });
		return c.json(await getSettings());
	})

	// Saved encrypted (secrets.ts), and only after OpenRouter accepts it: a wrong key would stop every reply.
	.put("/settings/openrouter-key", validate("json", z.object({ key: z.string().trim().min(20).max(500) }), { error: "Paste the whole key." }), async (c) => {
		const input = c.req.valid("json");
		const problem = await checkOpenRouterKey(input.key);
		if (problem) return c.json({ error: problem }, 400);
		await saveOpenRouterKey(input.key, adminOf(c));
		// That the key changed, never the key or any part of it.
		await record(c, "set-openrouter-key");
		return c.json(await openRouterKeyStatus());
	})

	// Skills (skills.ts): Markdown files of instructions, on for everyone or off.

	.get("/skills", async (c) => c.json({ skills: await listSkills() }))

	.get("/skills/:id", async (c) => {
		const id = skillId(c);
		const skill = id && (await getSkill(id));
		return skill ? c.json(skill) : noSkill(c);
	})

	.post("/skills", body(skillBody), async (c) => {
		const { expectedUpdatedAt: _, ...fields } = c.req.valid("json");
		const result = await saveSkill(fields, adminOf(c));
		if (result.ok) await record(c, "create-skill", { after: skillFields(result.skill) });
		return savedSkill(c, result);
	})

	.put("/skills/:id", body(skillBody), async (c) => {
		const id = skillId(c);
		const input = c.req.valid("json");
		if (!id) return noSkill(c);
		const before = await getSkill(id);
		const result = await saveSkill({ id, ...input }, adminOf(c));
		if (result.ok) await record(c, "update-skill", { before: before && skillFields(before), after: skillFields(result.skill, before) });
		return savedSkill(c, result);
	})

	.put("/skills/:id/enabled", body(z.object({ enabled: z.boolean() })), async (c) => {
		const id = skillId(c);
		const input = c.req.valid("json");
		const skill = id ? await getSkill(id) : undefined;
		const result = id ? await setSkillEnabled(id, input.enabled, adminOf(c)) : "missing";
		if (result === "empty") return c.json({ error: "Write the instructions before you turn the skill on." }, 400);
		if (result !== "ok" || !skill) return noSkill(c);
		await record(c, input.enabled ? "enable-skill" : "disable-skill", { after: { id: skill.id, name: skill.name, enabled: input.enabled } });
		return c.json({ ok: true });
	})

	.delete("/skills/:id", async (c) => {
		const id = skillId(c);
		const skill = id ? await getSkill(id) : undefined;
		if (!skill || !(await deleteSkill(skill.id, adminOf(c)))) return noSkill(c);
		await record(c, "delete-skill", { before: skillFields(skill) });
		return c.json({ ok: true });
	})

	// Requests for more credits (extra-credits.ts)

	.get("/requests", async (c) => c.json(await requestsReport()))

	.post("/requests/:id/approve", body(z.object({ credits: credits.min(1) })), (c) => answer(c, { status: "approved", credits: c.req.valid("json").credits }))

	.post("/requests/:id/decline", (c) => answer(c, { status: "declined" }));

function skillId(c: Context<Env>) {
	const id = Number(c.req.param("id"));
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function savedSkill(c: Context<Env>, result: SaveResult) {
	return result.ok ? c.json(result.skill) : c.json({ error: result.error, errors: result.errors }, result.status);
}

function noSkill(c: Context<Env>) {
	return c.json({ error: "This skill was deleted." }, 404);
}

/** A skill in the activity log: its settings, and whether the instructions changed since `before`, not the instructions. */
function skillFields(skill: SkillDetail, before?: SkillDetail) {
	const { id, name, description, automatic, enabled } = skill;
	return { id, name, description, automatic, enabled, ...(before && { instructionsChanged: before.body !== skill.body }) };
}

/** Records the answer, then emails the person. A failed email does not undo the answer. */
async function answer(c: Context<Env>, decision: Decision) {
	const id = Number(c.req.param("id"));
	if (!Number.isSafeInteger(id)) return notFound(c);
	const userId = await decideRequest(id, decision, adminOf(c));
	if (!userId) return c.json({ error: "This request was answered already." }, 409);
	await record(c, `${decision.status === "approved" ? "approve" : "decline"}-request`, { target: userId, after: { request: id, ...decision } });
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

/** Records the admin's change in the activity log (admin-events.ts). */
function record(c: Context<Env>, action: string, details: Pick<AdminEvent, "target" | "before" | "after"> = {}) {
	const { id, email } = c.get("user");
	return recordAdminEvent({ actor: { id, email }, action, ...details });
}

/** A person's own daily limit, or an invite's (by email). null for the default. */
async function ownDailyCredits(id: string) {
	const [row] = id.includes("@")
		? await sql<{ daily_credits: number | null }[]>`select daily_credits from allowed_emails where email = ${id}`
		: await sql<{ daily_credits: number | null }[]>`select daily_credits from credit_limits where user_id = ${id}`;
	return row?.daily_credits ?? null;
}

/** False when there is no such person or invite. */
async function saveDailyCredits(id: string, dailyCredits: number | null) {
	if (id.includes("@")) return setInviteCredits(id, dailyCredits);
	if (!(await hasAccount(id))) return false;
	await setDailyCredits(id, dailyCredits);
	return true;
}

/** By user id, or by email. */
async function hasAccount(idOrEmail: string) {
	const [row] = await sql`select 1 from users where id = ${idOrEmail} or lower(email) = ${idOrEmail.toLowerCase()}`;
	return Boolean(row);
}

function notFound(c: Context<Env>) {
	return c.json({ error: "No one here." }, 404);
}

function logEmailError(error: unknown) {
	console.error("email:", error instanceof Error ? error.message : error);
}
