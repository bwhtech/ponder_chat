// Makes someone an admin of Ponder Chat, or a user again. Run on the server with the app's environment:
//   npx tsx scripts/admin.ts grant someone@example.org
//   npx tsx scripts/admin.ts revoke someone@example.org
//   npx tsx scripts/admin.ts list
//   npx tsx scripts/admin.ts email-sign-in on
// The last turns sign-in by email on again, for when Microsoft sign-in stops working while email
// is off (its client secret expired in Entra, say). Restart the server after it: it keeps the setting in memory.
// The role lives in `users`, so a person needs an account first: they get one when they first sign in.
import * as Effect from "effect/Effect";
import * as SignInProviders from "../server/auth/SignInProviders.ts";
import * as Accounts from "../server/people/Accounts.ts";
import { runMain } from "../server/runtime/main.ts";

const [command, email] = process.argv.slice(2);
const noAccount = `${email} has no account yet. They get one when they first sign in.`;

await runMain(
	Effect.gen(function* () {
		const accounts = yield* Accounts.Accounts;
		if (command === "grant" && email) {
			yield* Effect.log((yield* accounts.setRole(email, "admin")) ? `${email} is now an admin.` : noAccount);
		} else if (command === "revoke" && email) {
			yield* Effect.log((yield* accounts.setRole(email, "user")) ? `${email} is now a user, not an admin.` : noAccount);
		} else if (command === "email-sign-in" && email === "on") {
			yield* SignInProviders.SignInProviders.use((providers) => providers.saveEmail(true, "scripts/admin.ts"));
			yield* Effect.log("Sign-in by email is on. Restart the server to use it.");
		} else if (command === "list") {
			for (const row of yield* accounts.listAdmins) yield* Effect.log(`${row.email}\t${row.role}\t${row.created_at.toISOString().slice(0, 10)}`);
		} else {
			yield* Effect.log("Usage: npx tsx scripts/admin.ts grant <email> | revoke <email> | list | email-sign-in on");
		}
	}),
);
