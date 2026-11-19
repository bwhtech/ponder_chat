import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";
import type { SignedInEnv } from "../auth.ts";
import * as Auth from "../auth/Auth.ts";
import { CALLBACK_PATH, SIGN_UPS } from "../auth/microsoft.ts";
import * as Branding from "../branding/Branding.ts";
import * as PonderConfig from "../config.ts";
import * as ExtraCredits from "../credits/ExtraCredits.ts";
import * as Accounts from "../people/Accounts.ts";
import { route } from "../runtime/route.ts";
import * as Settings from "../settings/Settings.ts";
import { MAX_BODY } from "../../shared/skill-file.ts";
import * as Skills from "../skills.ts";
import type { SaveResult, SkillDetail } from "../skills.ts";
import * as AdminActions from "./AdminActions.ts";
import * as AdminEvents from "./AdminEvents.ts";
import * as AdminReports from "./AdminReports.ts";
import { validate } from "../validate.ts";
import * as AdminWorkspaces from "../workspaces/admin.ts";

/**
 * The API behind /admin, mounted at /api/admin. Every route needs an admin (requireAdmin).
 * It returns usage numbers only: no route reads messages or thread titles. Workspaces
 * show in full only while they are open to everyone; private ones as totals (workspaces/admin.ts).
 *
 * What a route reads is in AdminReports.ts, and what it changes in AdminActions.ts, which
 * also records each change in the admin activity log (AdminEvents.ts). Role, ban and
 * sign-out go through Better Auth's admin plugin, which logs them in its hooks.
 */
type Env = SignedInEnv;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const credits = z.number().int().min(0).max(1_000_000);
const adminOf = (c: Context<Env>) => c.get("user").id;
const actorOf = (c: Context<Env>): AdminActions.Actor => ({ id: c.get("user").id, email: c.get("user").email });

/** One method of each service. */
const reports = <A, E>(use: (service: AdminReports.AdminReports["Service"]) => Effect.Effect<A, E>) => AdminReports.AdminReports.use(use);
const actions = <A, E>(use: (service: AdminActions.AdminActions["Service"]) => Effect.Effect<A, E>) => AdminActions.AdminActions.use(use);
const workspaces = <A, E>(use: (service: AdminWorkspaces.AdminWorkspaces["Service"]) => Effect.Effect<A, E>) => AdminWorkspaces.AdminWorkspaces.use(use);
const skills = <A, E>(use: (service: Skills.Skills["Service"]) => Effect.Effect<A, E>) => Skills.Skills.use(use);
/** The address the admin uses, for the links in emails (auth/Auth.ts). */
const originOf = (c: Context<Env>) => Auth.appOrigin(c.req.raw.headers);

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

// The server checks the values (auth/microsoft.ts); this only bounds them. No client secret: the saved one stays.
const microsoftBody = z.object({
	enabled: z.boolean(),
	tenantId: z.string().max(100),
	clientId: z.string().max(100),
	clientSecret: z.string().max(500).optional(),
	signUps: z.enum(SIGN_UPS),
	allowedDomains: z.array(z.string().max(260)).max(100),
});

// A little over the logo's limit, for the form around it. Larger is refused before it is read.
const logoLimit = bodyLimit({
	maxSize: Branding.MAX_LOGO_BYTES + 64 * 1024,
	onError: (c) => c.json({ error: "The logo is larger than 1 MB." }, 413),
});

// The overview covers 7, 14 or 30 days; any other value is 14.
const overviewQuery = z.object({ days: z.enum(["7", "14", "30"]).default("14").catch("14").transform(Number) });
// Values that are not ids are ignored, not refused.
const activityQuery = z.object({
	before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
	person: z.string().trim().optional().catch(undefined).transform((person) => person || undefined),
});

// The answers to the services' refusals.
const notFound = (_: unknown, c: Context) => c.json({ error: "No one here." }, 404);
/** A Better Auth admin endpoint's refusal, such as "You cannot ban yourself", passed on. */
const refused = (error: Auth.AuthRefused, c: Context) => c.json({ error: error.reason }, error.status as ContentfulStatusCode);
const ok = (c: Context) => () => c.json({ ok: true });

/**
 * Guards /api/admin/*: 403 unless the signed-in person is an admin. It reads the role from
 * the database (people/Accounts.ts), because the session in the cookie can be five minutes old.
 */
const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
	if (!(await route(c, Accounts.Accounts.use((accounts) => accounts.isAdmin(c.get("user").id))))) return c.json({ error: "Only admins can do this." }, 403);
	await next();
};

export const adminApi = new Hono<Env>()
	.use("*", requireAdmin)

	// For the sidebar's counts.
	.get("/summary", (c) => route(c, Effect.map(reports((service) => service.summary), (summary) => c.json(summary))))

	.get("/overview", validate("query", overviewQuery), (c) =>
		route(c, Effect.map(reports((service) => service.overview(c.req.valid("query").days)), (overview) => c.json(overview))),
	)

	// The admin activity log, newest first. `before` is the last id of the page before; `person` a user id or an invite's email.
	.get("/activity", validate("query", activityQuery), (c) => {
		const { before, person } = c.req.valid("query");
		return route(c, Effect.map(reports((service) => service.activity({ olderThan: before, person })), (page) => c.json(page)));
	})

	// Workspaces (workspaces/admin.ts): organisation ones in full, private ones as totals with no names.
	.get("/workspaces", (c) => route(c, Effect.map(workspaces((service) => service.report), (report) => c.json(report))))

	// An organisation document's indexing log. A private, deleted or unknown one is not found.
	.get("/workspaces/:id/documents/:doc/log", (c) =>
		route(
			c,
			Effect.map(workspaces((service) => service.documentLog(c.req.param("id"), c.req.param("doc"))), (log) =>
				Option.isSome(log) ? c.json(log.value) : c.json({ error: "Not found" }, 404),
			),
		),
	)

	// People

	.get("/people", (c) =>
		route(
			c,
			Effect.map(
				Effect.all([reports((service) => service.people), Settings.Settings.use((settings) => settings.get)]),
				([people, settings]) => c.json({ people, settings }),
			),
		),
	)

	.get("/people/:id", (c) =>
		route(
			c,
			Effect.gen(function* () {
				const detail = yield* reports((service) => service.person(c.req.param("id")));
				if (Option.isNone(detail)) return c.json({ error: "No one here." }, 404);
				return c.json({ ...detail.value, settings: yield* Settings.Settings.use((settings) => settings.get) });
			}),
		),
	)

	// An invited person's id is their email: the limit then waits in the invite (people/Invites.ts).
	.put("/people/:id/daily-credits", body(z.object({ credits: credits.nullable() })), (c) =>
		route(c, Effect.map(actions((service) => service.setDailyCredits(actorOf(c), c.req.param("id"), c.req.valid("json").credits)), ok(c)), { NoOne: notFound }),
	)

	.post("/people/:id/grant", body(z.object({ credits: credits.min(1) })), (c) =>
		route(c, Effect.map(actions((service) => service.grant(actorOf(c), c.req.param("id"), c.req.valid("json").credits)), ok(c)), { NoOne: notFound }),
	)

	.put("/people/:id/role", body(z.object({ role: z.enum(["admin", "user"]) })), (c) =>
		route(c, Effect.map(actions((service) => service.setRole(c.req.raw.headers, c.req.param("id"), c.req.valid("json").role)), ok(c)), {
			LastAdmin: (error, c) => c.json({ error: error.message }, 400),
			AuthRefused: refused,
		}),
	)

	.post("/people/:id/sign-out", (c) =>
		route(c, Effect.map(actions((service) => service.signOut(c.req.raw.headers, c.req.param("id"))), ok(c)), { AuthRefused: refused }),
	)

	.post("/people/:id/ban", body(z.object({ reason: z.string().trim().max(500).default(""), days: z.number().int().min(1).max(3650).nullable() })), (c) => {
		const input = c.req.valid("json");
		return route(c, Effect.map(actions((service) => service.ban(c.req.raw.headers, { userId: c.req.param("id"), reason: input.reason, days: input.days })), ok(c)), {
			AuthRefused: refused,
		});
	})

	// Their next sign-in with Microsoft links the account it shows (auth/microsoft.ts).
	.delete("/people/:id/microsoft", (c) =>
		route(c, Effect.map(actions((service) => service.unlinkMicrosoft(actorOf(c), c.req.param("id"))), ok(c)), { NoOne: notFound }),
	)

	.post("/people/:id/unban", (c) =>
		route(c, Effect.map(actions((service) => service.unban(c.req.raw.headers, c.req.param("id"))), ok(c)), { AuthRefused: refused }),
	)

	// Invites

	.post("/invites", body(inviteBody), (c) =>
		route(
			c,
			Effect.gen(function* () {
				const origin = yield* originOf(c);
				const result = yield* actions((service) => service.invite(actorOf(c), origin, c.req.valid("json")));
				if ("taken" in result) return c.json({ error: `Already invited: ${result.taken.join(", ")}` }, 409);
				return c.json({ invited: result.invited, notSent: result.notSent });
			}),
		),
	)

	.post("/invites/:email/send", (c) =>
		route(
			c,
			Effect.gen(function* () {
				const origin = yield* originOf(c);
				yield* actions((service) => service.sendInvite(actorOf(c), origin, c.req.param("email").toLowerCase()));
				return c.json({ ok: true });
			}),
			{ NoOne: notFound, EmailNotSent: (_, c) => c.json({ error: "The email could not be sent." }, 502) },
		),
	)

	.delete("/invites/:email", (c) =>
		route(c, Effect.map(actions((service) => service.removeInvite(actorOf(c), c.req.param("email").toLowerCase())), ok(c)), {
			SignedInAlready: (error, c) => c.json({ error: error.message }, 409),
			NoOne: notFound,
		}),
	)

	// Settings

	.get("/settings", (c) => route(c, Effect.map(actions((service) => service.settings), (settings) => c.json(settings))))

	.put("/settings", body(z.object({ defaultDailyCredits: credits, creditsPerUsd: z.number().int().min(1).max(1_000_000_000) })), (c) =>
		route(c, Effect.map(actions((service) => service.updateSettings(actorOf(c), c.req.valid("json"))), (settings) => c.json(settings))),
	)

	// How PDFs reach models that can't read them (settings/Settings.ts). Saved at once, apart from the credits.
	.put("/settings/pdf-reading", body(z.object({ onServer: z.boolean() })), (c) =>
		route(c, Effect.map(actions((service) => service.setPdfReading(actorOf(c), c.req.valid("json").onServer)), (settings) => c.json(settings))),
	)

	// The model that writes a chat's summary when it gets too long (compaction/summarize.ts). A model with a private (ZDR) endpoint.
	.put("/settings/compaction-model", body(z.object({ model: z.string() })), (c) =>
		route(c, Effect.map(actions((service) => service.setCompactionModel(actorOf(c), c.req.valid("json").model)), (settings) => c.json(settings)), {
			NoPrivateEndpoint: (error, c) => c.json({ error: error.message }, 400),
		}),
	)

	// How much Auto may spend on a request (models/AutoRouter.ts).
	.put("/settings/auto-cost-tier", body(z.object({ tier: z.enum(Settings.AUTO_COST_TIERS) })), (c) =>
		route(c, Effect.map(actions((service) => service.setAutoCostTier(actorOf(c), c.req.valid("json").tier)), (settings) => c.json(settings))),
	)

	// Saved encrypted (secrets/Secrets.ts), and only after OpenRouter accepts it: a wrong key would stop every reply.
	.put("/settings/openrouter-key", validate("json", z.object({ key: z.string().trim().min(20).max(500) }), { error: "Paste the whole key." }), (c) =>
		route(c, Effect.map(actions((service) => service.setOpenRouterKey(actorOf(c), c.req.valid("json").key)), (status) => c.json(status)), {
			KeyRefused: (error, c) => c.json({ error: error.reason }, 400),
		}),
	)

	// The organisation's logo for light or dark mode (branding/Branding.ts). The upload is a form, read
	// by the route, as the chat's files are (app.ts). Each answers with which logos are set after it.
	.put("/branding/logo/:theme", logoLimit, async (c) => {
		const theme = c.req.param("theme");
		if (!Branding.isTheme(theme)) return c.json({ error: "Not found" }, 404);
		const file = (await c.req.formData()).get("file");
		if (!(file instanceof File)) return c.json({ error: "No image in the upload." }, 400);
		const upload = Buffer.from(await file.arrayBuffer());
		return route(c, Effect.map(actions((service) => service.setLogo(actorOf(c), theme, upload)), (logos) => c.json({ logos })), {
			LogoRefused: (error, c) => c.json({ error: error.message }, 400),
		});
	})

	.delete("/branding/logo/:theme", async (c) => {
		const theme = c.req.param("theme");
		if (!Branding.isTheme(theme)) return c.json({ error: "Not found" }, 404);
		return route(c, Effect.map(actions((service) => service.removeLogo(actorOf(c), theme)), (logos) => c.json({ logos })));
	})

	// Sign in with Microsoft (auth/microsoft.ts). `redirectUris` are what the admin registers in Entra:
	// one for each address Ponder answers on, the one the admin uses now first.
	.get("/sign-in", (c) =>
		route(
			c,
			Effect.gen(function* () {
				const microsoft = yield* actions((service) => service.microsoftSignIn);
				const hosts = yield* PonderConfig.PonderConfig.useSync((config) => config.hosts);
				const origins = [yield* originOf(c), ...hosts.map((host) => Auth.originFor([host], new Headers({ host })))];
				return c.json({ microsoft, redirectUris: [...new Set(origins)].map((origin) => `${origin}${CALLBACK_PATH}`) });
			}),
		),
	)

	// Saved at once, with its own button: turning sign-in on or off is not part of the credits form.
	.put("/sign-in/microsoft", body(microsoftBody), (c) => {
		const { clientSecret, ...settings } = c.req.valid("json");
		return route(c, Effect.map(actions((service) => service.setMicrosoftSignIn(actorOf(c), settings, clientSecret)), (microsoft) => c.json({ microsoft })), {
			// The problem's name goes along, so the form shows the message at its field.
			InvalidSettings: (error, c) => c.json({ error: error.message, errors: [error.problem] }, 400),
		});
	})

	// Skills (skills.ts): Markdown files of instructions, on for everyone or off.

	.get("/skills", (c) => route(c, Effect.map(skills((service) => service.list), (list) => c.json({ skills: list }))))

	.get("/skills/:id", (c) =>
		route(
			c,
			Effect.gen(function* () {
				const id = skillId(c);
				const skill = id ? yield* skills((service) => service.get(id)) : Option.none<SkillDetail>();
				return Option.isSome(skill) ? c.json(skill.value) : noSkill(c);
			}),
		),
	)

	.post("/skills", body(skillBody), (c) =>
		route(
			c,
			Effect.gen(function* () {
				const { expectedUpdatedAt: _, ...fields } = c.req.valid("json");
				const result = yield* skills((service) => service.save(fields, adminOf(c)));
				if (result.ok) yield* record(c, "create-skill", { after: skillFields(result.skill) });
				return savedSkill(c, result);
			}),
		),
	)

	.put("/skills/:id", body(skillBody), (c) =>
		route(
			c,
			Effect.gen(function* () {
				const id = skillId(c);
				const input = c.req.valid("json");
				if (!id) return noSkill(c);
				const before = Option.getOrUndefined(yield* skills((service) => service.get(id)));
				const result = yield* skills((service) => service.save({ id, ...input }, adminOf(c)));
				if (result.ok) yield* record(c, "update-skill", { before: before && skillFields(before), after: skillFields(result.skill, before) });
				return savedSkill(c, result);
			}),
		),
	)

	.put("/skills/:id/enabled", body(z.object({ enabled: z.boolean() })), (c) =>
		route(
			c,
			Effect.gen(function* () {
				const id = skillId(c);
				const input = c.req.valid("json");
				const skill = id ? Option.getOrUndefined(yield* skills((service) => service.get(id))) : undefined;
				const result = id ? yield* skills((service) => service.setEnabled(id, input.enabled, adminOf(c))) : "missing";
				if (result === "empty") return c.json({ error: "Write the instructions before you turn the skill on." }, 400);
				if (result !== "ok" || !skill) return noSkill(c);
				yield* record(c, input.enabled ? "enable-skill" : "disable-skill", { after: { id: skill.id, name: skill.name, enabled: input.enabled } });
				return c.json({ ok: true });
			}),
		),
	)

	.delete("/skills/:id", (c) =>
		route(
			c,
			Effect.gen(function* () {
				const id = skillId(c);
				const skill = id ? Option.getOrUndefined(yield* skills((service) => service.get(id))) : undefined;
				if (!skill || !(yield* skills((service) => service.remove(skill.id, adminOf(c))))) return noSkill(c);
				yield* record(c, "delete-skill", { before: skillFields(skill) });
				return c.json({ ok: true });
			}),
		),
	)

	// Requests for more credits (credits/ExtraCredits.ts)

	.get("/requests", (c) => route(c, Effect.map(reports((service) => service.requests), (report) => c.json(report))))

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
function answer(c: Context<Env>, decision: ExtraCredits.Decision) {
	const id = Number(c.req.param("id"));
	return route(
		c,
		Effect.gen(function* () {
			if (!Number.isSafeInteger(id)) return c.json({ error: "No one here." }, 404);
			const origin = yield* originOf(c);
			yield* actions((service) => service.answer(actorOf(c), origin, id, decision));
			return c.json({ ok: true });
		}),
		{ AnsweredAlready: (error, c) => c.json({ error: error.message }, 409) },
	);
}

/** Records the admin's change in the activity log (AdminEvents.ts). */
function record(c: Context<Env>, action: string, details: Pick<AdminEvents.AdminEvent, "target" | "before" | "after"> = {}) {
	return AdminEvents.AdminEvents.use((events) => events.record({ actor: actorOf(c), action, ...details }));
}
