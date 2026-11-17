/**
 * The environment of the workspace tests (*.test.ts here): the app's layer on
 * TEST_DATABASE_URL, in a schema of the test's own (search_path), with memory, Python and
 * OpenRouter off. Import it before the app's modules: the layer reads the environment when
 * it is built (config.ts). The users table there is a small one of the test's own, as in
 * people/Invites.test.ts.
 */
export const base = process.env.TEST_DATABASE_URL;

export function useTestSchema(schema: string) {
	if (!base) return;
	Object.assign(process.env, {
		DATABASE_URL: `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`,
		BETTER_AUTH_SECRET: "test-secret-for-the-workspaces-0123456789abcdef",
		PONDER_MEMORY: "off",
		PONDER_PYTHON: "off",
		OPENROUTER_API_KEY: "sk-or-v1-test",
		// Nothing answers here: the title and the models list fail at once, and are logged.
		OPENROUTER_BASE_URL: "http://127.0.0.1:9/api",
	});
}

/** Better Auth's users, with only the columns Ponder reads. */
export const USERS_TABLE = `create table users (
	id text primary key, name text, email text not null, role text, banned boolean,
	"createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now()
)`;
