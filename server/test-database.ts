import { Client } from "pg";

/**
 * Makes pgvector once, before the test files start side by side on one database. Each file
 * makes it if it is missing, and on a new database two doing that at once fail: "if not
 * exists" does not hold against a race.
 */
export async function setup() {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) return;
	const client = new Client({ connectionString: url });
	await client.connect();
	await client.query("create extension if not exists vector schema public");
	await client.end();
}
