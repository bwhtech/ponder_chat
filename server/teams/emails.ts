import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SignInProviders from "../auth/SignInProviders.ts";
import * as Mailer from "../email/Mailer.ts";
import { displayName } from "../../shared/display-name.ts";
import type { Rows } from "./rows.ts";

/**
 * The emails of teams (docs/teams-plan.md, "Emails"): the invite of a new email, and the
 * note to a person with an account that someone added them to a team. Teams.ts sends them
 * after the change is committed. A failed email is logged and changes nothing.
 */
export type TeamEmails = {
	added: (to: string, origin: string, notice: { team: string; byUserId: string; admin: boolean }) => Effect.Effect<void>;
	invited: (to: string, origin: string, notice: { team: string; byUserId: string }) => Effect.Effect<void>;
};

export function teamEmails(mailer: Mailer.Mailer["Service"], providers: SignInProviders.SignInProviders["Service"], rows: Rows): TeamEmails {
	/** Who did it, as the email names them. */
	const nameOf = (userId: string) =>
		Effect.map(rows.name(userId), Option.match({ onNone: () => "an admin", onSome: (found) => displayName(found.name, found.email) }));

	const send = (email: Effect.Effect<Mailer.Email, unknown>) =>
		Effect.flatMap(email, (built) => mailer.send(built)).pipe(
			Effect.catch((error) => Effect.logError("team email:", error instanceof Mailer.EmailNotSent ? error.message : error)),
			Effect.withSpan("Teams.email"),
		);

	return {
		added: (to, origin, { team, byUserId, admin }) => send(Effect.map(nameOf(byUserId), (by) => Mailer.addedToTeamEmail(to, origin, { team, by, admin }))),
		invited: (to, origin, { team, byUserId }) =>
			send(
				Effect.gen(function* () {
					const withMicrosoft = !(yield* providers.active).email;
					return Mailer.inviteEmail(to, origin, withMicrosoft, { team, by: yield* nameOf(byUserId) });
				}),
			),
	};
}
