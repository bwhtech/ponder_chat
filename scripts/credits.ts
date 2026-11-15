// Gives one person more (or fewer) daily credits than the default (/admin, Settings). Run on the server with the app's environment:
//   npx tsx scripts/credits.ts set someone@example.org 3000
//   npx tsx scripts/credits.ts reset someone@example.org
//   npx tsx scripts/credits.ts list
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Credits from "../server/credits/Credits.ts";
import * as Accounts from "../server/people/Accounts.ts";
import { runMain } from "../server/runtime/main.ts";

const [command, email, amount] = process.argv.slice(2);

/** The account for an email. A person has one after their first sign-in. */
const userId = Effect.fn(function* (address: string) {
	const id = yield* Accounts.Accounts.use((accounts) => accounts.idOfEmail(address));
	if (Option.isNone(id)) yield* Effect.log(`${address} has no account yet. They get one when they first sign in.`);
	return id;
});

await runMain(
	Effect.gen(function* () {
		const credits = yield* Credits.Credits;
		yield* credits.migrate;
		if (command === "set" && email && Number.isInteger(Number(amount)) && Number(amount) >= 0) {
			const id = yield* userId(email);
			if (Option.isSome(id)) {
				yield* credits.setDailyCredits(id.value, Number(amount));
				const status = yield* credits.status(id.value);
				yield* Effect.log(`${email} now has ${status.limit} credits a day. Used today: ${status.used}.`);
			}
		} else if (command === "reset" && email) {
			const id = yield* userId(email);
			if (Option.isSome(id)) {
				yield* credits.setDailyCredits(id.value, null);
				yield* Effect.log(`${email} is back on the default of ${(yield* credits.status(id.value)).limit} credits a day.`);
			}
		} else if (command === "list") {
			for (const row of yield* credits.listDailyCredits) yield* Effect.log(`${row.email}\t${row.daily_credits}\t${row.updated_at.toISOString().slice(0, 10)}`);
		} else {
			yield* Effect.log("Usage: npx tsx scripts/credits.ts set <email> <credits a day> | reset <email> | list");
		}
	}),
);
