// Makes someone an admin of Ponder Chat, or a user again. Run on the server with the app's environment:
//   npx tsx scripts/admin.ts grant someone@example.org
//   npx tsx scripts/admin.ts revoke someone@example.org
//   npx tsx scripts/admin.ts list
// The role lives in `users`, so a person needs an account first: they get one when they first sign in.
import { listAdmins, setRole } from "../server/admins.ts";
import { sql } from "../server/db.ts";

const [command, email] = process.argv.slice(2);
const noAccount = `${email} has no account yet. They get one when they first sign in.`;

if (command === "grant" && email) {
	console.log((await setRole(email, "admin")) ? `${email} is now an admin.` : noAccount);
} else if (command === "revoke" && email) {
	console.log((await setRole(email, "user")) ? `${email} is now a user, not an admin.` : noAccount);
} else if (command === "list") {
	for (const row of await listAdmins()) console.log(`${row.email}\t${row.role}\t${row.created_at.toISOString().slice(0, 10)}`);
} else {
	console.log("Usage: npx tsx scripts/admin.ts grant <email> | revoke <email> | list");
}
await sql.end();
