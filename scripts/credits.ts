// Gives one person more (or fewer) daily credits than the default (/admin, Settings). Run on the server with the app's environment:
//   npx tsx scripts/credits.ts set someone@example.org 3000
//   npx tsx scripts/credits.ts reset someone@example.org
//   npx tsx scripts/credits.ts list
import { sql } from "../server/db.ts";
import { creditStatus, listDailyCredits, migrateCredits, setDailyCredits } from "../server/credits.ts";

const [command, email, amount] = process.argv.slice(2);
await migrateCredits();

/** The account for an email. A person has one after their first sign-in. */
async function userId(address: string) {
	const [row] = await sql<{ id: string }[]>`select id from users where lower(email) = ${address.trim().toLowerCase()}`;
	if (!row) console.log(`${address} has no account yet. They get one when they first sign in.`);
	return row?.id;
}

if (command === "set" && email && Number.isInteger(Number(amount)) && Number(amount) >= 0) {
	const id = await userId(email);
	if (id) {
		await setDailyCredits(id, Number(amount));
		const status = await creditStatus(id);
		console.log(`${email} now has ${status.limit} credits a day. Used today: ${status.used}.`);
	}
} else if (command === "reset" && email) {
	const id = await userId(email);
	if (id) {
		await setDailyCredits(id, null);
		console.log(`${email} is back on the default of ${(await creditStatus(id)).limit} credits a day.`);
	}
} else if (command === "list") {
	for (const row of await listDailyCredits()) console.log(`${row.email}\t${row.daily_credits}\t${row.updated_at.toISOString().slice(0, 10)}`);
} else {
	console.log("Usage: npx tsx scripts/credits.ts set <email> <credits a day> | reset <email> | list");
}
await sql.end();
