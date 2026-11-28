// Invites pilot users. Run on the server with the app's environment:
//   npx tsx scripts/invite.ts add someone@example.org "Pilot group 1"
//   npx tsx scripts/invite.ts remove someone@example.org
//   npx tsx scripts/invite.ts list
import * as Effect from "effect/Effect";
import * as AdminEvents from "../server/admin/AdminEvents.ts";
import * as Invites from "../server/people/Invites.ts";
import { runMain } from "../server/runtime/main.ts";

const [command, email, note] = process.argv.slice(2);
// Who the activity log names for this script's changes.
const SCRIPT = { id: "scripts/invite.ts", email: "scripts/invite.ts" };

await runMain(
	Effect.gen(function* () {
		const invites = yield* Invites.Invites;
		yield* invites.migrate;
		if (command === "add" && email) {
			yield* invites.allow(email, { note: note ?? "" });
			yield* Effect.log(`Invited ${email}.`);
		} else if (command === "remove" && email) {
			const removed = yield* invites.disallow(email);
			yield* Effect.log(removed.invited ? `Removed ${email}. Their account stays; they cannot get a new sign-in link.` : `${email} was not invited.`);
			const events = yield* AdminEvents.AdminEvents;
			for (const before of removed.teamInvites) {
				yield* events.record({ actor: SCRIPT, action: "cancel-team-invite", target: email, before });
				yield* Effect.log(`Cancelled its invite to the team ${before.name}.`);
			}
		} else if (command === "list") {
			for (const row of yield* invites.list) yield* Effect.log(`${row.email}\t${row.note}\t${row.created_at.toISOString().slice(0, 10)}`);
		} else {
			yield* Effect.log('Usage: npx tsx scripts/invite.ts add <email> ["note"] | remove <email> | list');
		}
	}),
);
