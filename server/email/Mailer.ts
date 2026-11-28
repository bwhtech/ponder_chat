import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { teamRoleName } from "../../shared/team-role.ts";
import * as PonderConfig from "../config.ts";

/**
 * Email from Ponder: sign-in codes, invites (to Ponder and to a team), answers to requests for more credits, and the
 * notice of an email change. Sent with Cloudflare Email Service's REST
 * API when it is set up (PONDER_EMAIL_FROM, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_TOKEN);
 * otherwise, as on a laptop, the message is printed to the server log.
 *
 * CLOUDFLARE_API_URL points the calls at another server in place of Cloudflare's API,
 * such as the end-to-end tests' fake (e2e/fake/).
 */
export type Email = { to: string; subject: string; text: string; html: string };

/**
 * Cloudflare did not send the email: its HTTP status, or none when it could not be reached
 * (the cause). Not Cloudflare's answer, which can name the address.
 */
export class EmailNotSent extends Schema.TaggedError<EmailNotSent>()("EmailNotSent", {
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.status === undefined ? "The email could not be sent." : `The email could not be sent (${this.status}).`;
	}
}

export class Mailer extends Context.Service<
	Mailer,
	{
		/** Sends the email, or prints it to the log when no sender is set up. */
		readonly send: (email: Email) => Effect.Effect<void, EmailNotSent>;
	}
>()("ponder/email/Mailer") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const client = yield* HttpClient.HttpClient;

	const send = Effect.fn("Mailer.send")(function* (email: Email) {
		if (Option.isNone(config.email)) {
			yield* Effect.log(`email (not sent, no sender set up) to ${email.to}: ${email.subject}\n${email.text}`);
			return;
		}
		const { from, accountId, token } = config.email.value;
		const request = HttpClientRequest.post(`${config.cloudflareApiUrl}/accounts/${accountId}/email/sending/send`).pipe(
			HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
			HttpClientRequest.bodyJsonUnsafe({ from, ...email }),
		);
		// The cause is fetch's own error: the client's names the address.
		const response = yield* client.execute(request).pipe(Effect.catchTags({ HttpClientError: (error) => Effect.fail(new EmailNotSent({ cause: error.reason.cause })) }));
		if (response.status < 200 || response.status >= 300) return yield* new EmailNotSent({ status: response.status });
	});

	return Mailer.of({ send });
});

export const layer = Layer.effect(Mailer, make);

/**
 * The sign-in email: a 6-digit code, large so it is easy to read, and the link below it.
 * A code asked for on its own (auth.ts) comes without the link.
 */
export function signInEmail(to: string, code: string, url?: string): Email {
	const expiry = url ? "The code and the link expire in 15 minutes. Each works once." : "The code expires in 15 minutes and works once.";
	const ignore = "If you did not ask to sign in, ignore this email.";
	const linkText = url ? `\n\nOr open this link to sign in:\n\n${url}` : "";
	const linkHtml = url ? `<p>Or open this link to sign in:</p><p><a href="${url}">Sign in to Ponder Chat</a></p>` : "";
	return {
		to,
		// The code in the subject, so it shows in the notification without opening the email.
		subject: `${code} is your OTP for Ponder Chat.`,
		text: `Your code to sign in to Ponder Chat:\n\n${code}\n\nType it on the sign-in page.${linkText}\n\n${expiry} ${ignore}`,
		html:
			`<p>Your code to sign in to Ponder Chat:</p>` +
			`<p style="margin:16px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:6px">${code}</p>` +
			`<p>Type it on the sign-in page.</p>${linkHtml}` +
			`<p style="color:#666">${expiry} ${ignore}</p>`,
	};
}

/** The team an email is about, and who invited or added the person, by name (teams/Teams.ts). */
export type TeamNotice = { team: string; by: string };

/**
 * An admin invited this email (/admin, People), or a team admin to their team. `url` is
 * Ponder's sign-in page. With `withMicrosoft`, sign-in by email is off and the person signs
 * in with Microsoft.
 */
export function inviteEmail(to: string, url: string, withMicrosoft = false, team?: TeamNotice): Email {
	const how = withMicrosoft ? `choose Sign in with Microsoft, and use your work account (${to}).` : `type this email address (${to}), and Ponder Chat sends you a code to sign in.`;
	const note = withMicrosoft ? "You sign in as you do to Microsoft 365." : "You do not need a password.";
	const joins = team ? `${team.by} invited you to the team “${team.team}”. You join it when you first sign in.` : "";
	return {
		to,
		subject: "You are invited to Ponder Chat",
		text: `You are invited to Ponder Chat.${joins ? `\n\n${joins}` : ""}\n\nOpen ${url}, ${how}\n\n${note}`,
		html:
			`<p>You are invited to Ponder Chat.</p>` +
			(joins ? `<p>${escapeHtml(joins)}</p>` : "") +
			`<p>Open <a href="${url}">${url}</a>, ${how}</p>` +
			`<p style="color:#666">${note}</p>`,
	};
}

/** A team admin or an org admin added a person who has an account to a team (teams/Teams.ts). */
export function addedToTeamEmail(to: string, url: string, { team, by, role }: TeamNotice & { role: string }): Email {
	const added = `You were added to ${team} as ${teamRoleName(role)} by ${by}.`;
	return {
		to,
		subject: `You were added to ${team}`,
		text: `${added}\n\nOpen Ponder Chat: ${url}`,
		html: `<p>${escapeHtml(added)}</p><p><a href="${url}">Open Ponder Chat</a></p>`,
	};
}

/** An admin answered the person's request for more credits. */
export function creditAnswerEmail(to: string, url: string, credits: number | null): Email {
	const answer = credits
		? `An admin gave you ${credits} more credits for today. They are added to today's limit.`
		: "An admin did not give you more credits today.";
	const refill = "Your credits refill at midnight UTC as usual.";
	return {
		to,
		subject: credits ? "You have more credits for today" : "About your request for more credits",
		text: `${answer} ${refill}\n\nOpen Ponder Chat: ${url}`,
		html: `<p>${answer}</p><p>${refill}</p><p><a href="${url}">Open Ponder Chat</a></p>`,
	};
}

/**
 * An admin changed the account's email (admin-auth-events.ts). Sent to the old address,
 * which no longer signs in, so the person can object if they did not expect it.
 */
export function emailChangedEmail(to: string, newEmail: string, admin: string): Email {
	const changed = `An admin, ${admin}, changed the email of your Ponder Chat account from ${to} to ${newEmail}.`;
	const after = `You can no longer sign in with ${to}. Sign-in codes now go to ${newEmail}.`;
	const contact = "If you did not expect this, contact the admin.";
	return {
		to,
		subject: "The email of your Ponder Chat account changed",
		text: `${changed}\n\n${after}\n\n${contact}`,
		html: `<p>${escapeHtml(changed)}</p><p>${escapeHtml(after)}</p><p style="color:#666">${contact}</p>`,
	};
}

/** For text that a person can choose, such as an admin's name. */
function escapeHtml(text: string) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
