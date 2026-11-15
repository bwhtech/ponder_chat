import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as Auth from "../auth/Auth.ts";
import * as Credits from "../credits/Credits.ts";
import * as ExtraCredits from "../credits/ExtraCredits.ts";
import * as Mailer from "../email/Mailer.ts";
import * as Models from "../models/Models.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import * as Accounts from "../people/Accounts.ts";
import * as Invites from "../people/Invites.ts";
import * as Settings from "../settings/Settings.ts";
import * as AdminEvents from "./AdminEvents.ts";
import * as AdminReports from "./AdminReports.ts";

/**
 * What admins change on /admin (admin/routes.ts): people's limits and roles, bans, invites,
 * requests for more credits, and the settings.
 *
 * Role, ban and sign-out go through Better Auth's admin plugin (auth.api), which checks
 * the admin's session again (the request's headers) and ends a banned person's sessions.
 *
 * Each change goes to the admin activity log (AdminEvents.ts). The changes made through
 * Better Auth are logged in its hooks (auth/AdminAuthEvents.ts), so not here.
 */

/** The admin who makes the change. */
export type Actor = { id: string; email: string };

/** No such person or invite. */
export class NoOne extends Schema.TaggedError<NoOne>()("NoOne", {}) {
	override get message() {
		return "No one here.";
	}
}

/** The last admin can't become a user. */
export class LastAdmin extends Schema.TaggedError<LastAdmin>()("LastAdmin", {}) {
	override get message() {
		return "Ponder Chat needs at least one admin.";
	}
}

/** An invite whose person has an account: it can't be taken back. */
export class SignedInAlready extends Schema.TaggedError<SignedInAlready>()("SignedInAlready", {}) {
	override get message() {
		return "They have signed in already. Ban them instead.";
	}
}

/** The compaction model must have a private (ZDR) endpoint. */
export class NoPrivateEndpoint extends Schema.TaggedError<NoPrivateEndpoint>()("NoPrivateEndpoint", {}) {
	override get message() {
		return "That model has no private endpoint now. Choose another.";
	}
}

/** OpenRouter did not accept the key, or could not check it: OpenRouterKey.check's fixed text. */
export class KeyRefused extends Schema.TaggedError<KeyRefused>()("KeyRefused", { reason: Schema.String }) {
	override get message() {
		return this.reason;
	}
}

/** The request for more credits was answered already. */
export class AnsweredAlready extends Schema.TaggedError<AnsweredAlready>()("AnsweredAlready", {}) {
	override get message() {
		return "This request was answered already.";
	}
}

export type NewInvites = { emails: string[]; note: string; dailyCredits: number | null; sendEmail: boolean };
/** Emails invited or with an account already, and none invited; or how many were, and those whose email was not sent. */
export type InviteResult = { taken: string[] } | { invited: number; notSent: string[] };
export type Ban = { userId: string; reason: string; days: number | null };

export class AdminActions extends Context.Service<
	AdminActions,
	{
		/** Sets a person's daily limit, or an invite's (by email: the limit then waits in the invite); null for the default. */
		readonly setDailyCredits: (actor: Actor, id: string, credits: number | null) => Effect.Effect<void, NoOne | SqlError>;
		/** Extra credits for today. */
		readonly grant: (actor: Actor, userId: string, credits: number) => Effect.Effect<void, NoOne | SqlError>;
		readonly setRole: (headers: Headers, userId: string, role: Accounts.Role) => Effect.Effect<void, LastAdmin | Auth.AuthRefused | SqlError>;
		/** Ends every session of the person. */
		readonly signOut: (headers: Headers, userId: string) => Effect.Effect<void, Auth.AuthRefused>;
		readonly ban: (headers: Headers, ban: Ban) => Effect.Effect<void, Auth.AuthRefused>;
		readonly unban: (headers: Headers, userId: string) => Effect.Effect<void, Auth.AuthRefused>;
		/** Invites these lowercase emails, none if any is taken, and emails them if asked, with links to `origin`. */
		readonly invite: (actor: Actor, origin: string, invites: NewInvites) => Effect.Effect<InviteResult, SqlError>;
		/** Emails an invite again. */
		readonly sendInvite: (actor: Actor, origin: string, email: string) => Effect.Effect<void, NoOne | Mailer.EmailNotSent | SqlError>;
		readonly removeInvite: (actor: Actor, email: string) => Effect.Effect<void, NoOne | SignedInAlready | SqlError>;
		/** The Settings page: the settings, the admins, the OpenRouter key's state and the models with a private endpoint. */
		readonly settings: Effect.Effect<SettingsPage, SqlError>;
		/** These return the settings after the change. */
		readonly updateSettings: (actor: Actor, input: Settings.CreditSettings) => Effect.Effect<Settings.AppSettings, SqlError>;
		readonly setPdfReading: (actor: Actor, onServer: boolean) => Effect.Effect<Settings.AppSettings, SqlError>;
		readonly setCompactionModel: (actor: Actor, model: string) => Effect.Effect<Settings.AppSettings, NoPrivateEndpoint | SqlError>;
		readonly setAutoCostTier: (actor: Actor, tier: Settings.AutoCostTier) => Effect.Effect<Settings.AppSettings, SqlError>;
		/** Saves the key once OpenRouter accepts it: a wrong key would stop every reply. The key's state after it. */
		readonly setOpenRouterKey: (actor: Actor, key: string) => Effect.Effect<OpenRouterKey.KeyStatus, KeyRefused | SqlError>;
		/** Answers a request for more credits, then emails the person, with a link to `origin`. A failed email does not undo the answer. */
		readonly answer: (actor: Actor, origin: string, requestId: number, decision: ExtraCredits.Decision) => Effect.Effect<void, AnsweredAlready | SqlError>;
	}
>()("ponder/admin/AdminActions") {}

type SettingsPage = Settings.AppSettings & {
	admins: { id: string; name: string; email: string }[];
	openRouterKey: OpenRouterKey.KeyStatus;
	models: { id: string; name: string }[];
};

const make = Effect.gen(function* () {
	const auth = yield* Auth.Auth;
	const accounts = yield* Accounts.Accounts;
	const invites = yield* Invites.Invites;
	const credits = yield* Credits.Credits;
	const extraCredits = yield* ExtraCredits.ExtraCredits;
	const settings = yield* Settings.Settings;
	const openRouterKey = yield* OpenRouterKey.OpenRouterKey;
	const models = yield* Models.Models;
	const mailer = yield* Mailer.Mailer;
	const adminEvents = yield* AdminEvents.AdminEvents;
	const reports = yield* AdminReports.AdminReports;

	const record = (actor: Actor, action: string, details: Pick<AdminEvents.AdminEvent, "target" | "before" | "after"> = {}) =>
		adminEvents.record({ actor: { id: actor.id, email: actor.email }, action, ...details });

	const logEmailError = (error: Mailer.EmailNotSent) => Effect.logError("email:", error.message);

	/** A person's own daily limit, or an invite's (by email). null for the default. */
	const ownDailyCredits = (id: string) =>
		id.includes("@")
			? Effect.map(invites.inviteCredits(id), (limit) => Option.getOrNull(limit))
			: Effect.map(credits.ownLimit(id), (limit) => Option.getOrNull(limit));

	/** False when there is no such person or invite. */
	const saveDailyCredits = Effect.fnUntraced(function* (id: string, dailyCredits: number | null) {
		if (id.includes("@")) return yield* invites.setInviteCredits(id, dailyCredits);
		if (!(yield* accounts.hasAccount(id))) return false;
		yield* credits.setDailyCredits(id, dailyCredits);
		return true;
	});

	const setDailyCredits = Effect.fn("AdminActions.setDailyCredits")(function* (actor: Actor, id: string, dailyCredits: number | null) {
		const target = id.includes("@") ? id.toLowerCase() : id;
		const before = { dailyCredits: yield* ownDailyCredits(target) };
		if (!(yield* saveDailyCredits(target, dailyCredits))) return yield* new NoOne();
		yield* record(actor, "set-daily-credits", { target, before, after: { dailyCredits } });
	});

	const grant = Effect.fn("AdminActions.grant")(function* (actor: Actor, userId: string, amount: number) {
		if (!(yield* accounts.hasAccount(userId))) return yield* new NoOne();
		yield* extraCredits.grant(userId, amount, actor.id);
		yield* record(actor, "grant-credits", { target: userId, after: { credits: amount } });
	});

	const setRole = Effect.fn("AdminActions.setRole")(function* (headers: Headers, userId: string, role: Accounts.Role) {
		if (role === "user" && (yield* reports.admins).every((admin) => admin.id === userId)) return yield* new LastAdmin();
		yield* auth.call((api) => api.setRole({ body: { userId, role }, headers }));
	});

	const signOut = Effect.fn("AdminActions.signOut")(function* (headers: Headers, userId: string) {
		yield* auth.call((api) => api.revokeUserSessions({ body: { userId }, headers }));
	});

	const ban = Effect.fn("AdminActions.ban")(function* (headers: Headers, { userId, reason, days }: Ban) {
		const banned = { userId, banReason: reason || undefined, banExpiresIn: days ? days * 86_400 : undefined };
		yield* auth.call((api) => api.banUser({ body: banned, headers }));
	});

	const unban = Effect.fn("AdminActions.unban")(function* (headers: Headers, userId: string) {
		yield* auth.call((api) => api.unbanUser({ body: { userId }, headers }));
	});

	/** Sends the invite emails. Returns the addresses that could not be sent to. */
	const emailInvites = Effect.fnUntraced(function* (origin: string, emails: ReadonlyArray<string>) {
		const notSent: string[] = [];
		for (const email of emails) {
			yield* mailer.send(Mailer.inviteEmail(email, origin)).pipe(
				Effect.catchTags({
					EmailNotSent: (error) => Effect.andThen(logEmailError(error), Effect.sync(() => notSent.push(email))),
				}),
			);
		}
		return notSent;
	});

	const invite = Effect.fn("AdminActions.invite")(function* (actor: Actor, origin: string, input: NewInvites) {
		const emails = [...new Set(input.emails)];
		const taken = yield* invites.taken(emails);
		if (taken.length) return { taken: [...taken] } satisfies InviteResult;
		for (const email of emails) yield* invites.allow(email, { note: input.note, invitedBy: actor.id, dailyCredits: input.dailyCredits });
		const notSent = input.sendEmail ? yield* emailInvites(origin, emails) : [];
		for (const email of emails) {
			const emailed = input.sendEmail && !notSent.includes(email);
			yield* record(actor, "invite", { target: email, after: { note: input.note, dailyCredits: input.dailyCredits, emailed } });
		}
		return { invited: emails.length, notSent } satisfies InviteResult;
	});

	const sendInvite = Effect.fn("AdminActions.sendInvite")(function* (actor: Actor, origin: string, email: string) {
		if (!(yield* invites.invited(email))) return yield* new NoOne();
		yield* mailer.send(Mailer.inviteEmail(email, origin)).pipe(Effect.tapError(logEmailError));
		yield* record(actor, "send-invite", { target: email });
	});

	const removeInvite = Effect.fn("AdminActions.removeInvite")(function* (actor: Actor, email: string) {
		if (yield* accounts.hasAccount(email)) return yield* new SignedInAlready();
		if (!(yield* invites.disallow(email))) return yield* new NoOne();
		yield* record(actor, "remove-invite", { target: email });
	});

	const settingsPage = Effect.gen(function* () {
		const { current, admins, key, available } = yield* Effect.all({ current: settings.get, admins: reports.admins, key: openRouterKey.status, available: models.privateModels });
		return {
			...current,
			admins,
			openRouterKey: key,
			// Only models with a private (ZDR) endpoint: another would fall back to the chat's own model.
			models: available.map(({ id, name }) => ({ id, name })),
		} satisfies SettingsPage;
	}).pipe(Effect.withSpan("AdminActions.settings"));

	const updateSettings = Effect.fn("AdminActions.updateSettings")(function* (actor: Actor, input: Settings.CreditSettings) {
		const { defaultDailyCredits, creditsPerUsd } = yield* settings.get;
		yield* settings.update(input, actor.id);
		yield* record(actor, "update-settings", { before: { defaultDailyCredits, creditsPerUsd }, after: input });
		return yield* settings.get;
	});

	const setPdfReading = Effect.fn("AdminActions.setPdfReading")(function* (actor: Actor, onServer: boolean) {
		const before = { pdfTextOnServer: (yield* settings.get).pdfTextOnServer };
		yield* settings.setPdfTextOnServer(onServer, actor.id);
		yield* record(actor, "set-pdf-reading", { before, after: { pdfTextOnServer: onServer } });
		return yield* settings.get;
	});

	const setCompactionModel = Effect.fn("AdminActions.setCompactionModel")(function* (actor: Actor, model: string) {
		const available = yield* models.privateModels;
		if (!available.some((one) => one.id === model)) return yield* new NoPrivateEndpoint();
		const before = { compactionModel: (yield* settings.get).compactionModel };
		yield* settings.setCompactionModel(model, actor.id);
		yield* record(actor, "set-compaction-model", { before, after: { compactionModel: model } });
		return yield* settings.get;
	});

	const setAutoCostTier = Effect.fn("AdminActions.setAutoCostTier")(function* (actor: Actor, tier: Settings.AutoCostTier) {
		const before = { autoCostTier: (yield* settings.get).autoCostTier };
		yield* settings.setAutoCostTier(tier, actor.id);
		yield* record(actor, "set-auto-cost-tier", { before, after: { autoCostTier: tier } });
		return yield* settings.get;
	});

	const setOpenRouterKey = Effect.fn("AdminActions.setOpenRouterKey")(function* (actor: Actor, key: string) {
		const problem = yield* openRouterKey.check(key);
		if (Option.isSome(problem)) return yield* new KeyRefused({ reason: problem.value });
		yield* openRouterKey.save(key, actor.id);
		// That the key changed, never the key or any part of it.
		yield* record(actor, "set-openrouter-key");
		return yield* openRouterKey.status;
	});

	const answer = Effect.fn("AdminActions.answer")(function* (actor: Actor, origin: string, requestId: number, decision: ExtraCredits.Decision) {
		const userId = yield* extraCredits.decide(requestId, decision, actor.id);
		if (Option.isNone(userId)) return yield* new AnsweredAlready();
		yield* record(actor, `${decision.status === "approved" ? "approve" : "decline"}-request`, { target: userId.value, after: { request: requestId, ...decision } });
		const email = yield* accounts.emailOf(userId.value);
		const granted = decision.status === "approved" ? decision.credits : null;
		if (Option.isSome(email)) yield* mailer.send(Mailer.creditAnswerEmail(email.value, origin, granted)).pipe(Effect.catchTags({ EmailNotSent: logEmailError }));
	});

	return AdminActions.of({
		setDailyCredits,
		grant,
		setRole,
		signOut,
		ban,
		unban,
		invite,
		sendInvite,
		removeInvite,
		settings: settingsPage,
		updateSettings,
		setPdfReading,
		setCompactionModel,
		setAutoCostTier,
		setOpenRouterKey,
		answer,
	});
});

export const layer = Layer.effect(AdminActions, make);
