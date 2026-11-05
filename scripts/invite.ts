// Invites pilot users. Run on the server with the app's environment:
//   npx tsx scripts/invite.ts add someone@example.org "Pilot group 1"
//   npx tsx scripts/invite.ts remove someone@example.org
//   npx tsx scripts/invite.ts list
import { sql } from "../server/db.ts";
import { allow, disallow, listAllowed, migrateInvites } from "../server/invites.ts";

const [command, email, note] = process.argv.slice(2);
await migrateInvites();
if (command === "add" && email) {
	await allow(email, note ?? "");
	console.log(`Invited ${email}.`);
} else if (command === "remove" && email) {
	console.log((await disallow(email)) ? `Removed ${email}. Their account stays; they cannot get a new sign-in link.` : `${email} was not invited.`);
} else if (command === "list") {
	for (const row of await listAllowed()) console.log(`${row.email}\t${row.note}\t${row.created_at.toISOString().slice(0, 10)}`);
} else {
	console.log('Usage: npx tsx scripts/invite.ts add <email> ["note"] | remove <email> | list');
}
await sql.end();
