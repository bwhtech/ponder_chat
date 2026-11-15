import { defineConfig } from "vitest/config";

/**
 * The server's unit tests (npm run test): server/**\/*.test.ts, with @effect/vitest.
 * The web app has none; e2e/ is Playwright's.
 *
 * Tests that need Postgres run only when TEST_DATABASE_URL is set, and skip otherwise.
 * It is its own variable, not DATABASE_URL, so a shell with Ponder's real database in its
 * environment never runs them there. They make their own rows and tables and delete them.
 * CI runs them in the e2e job, on its Postgres (.github/workflows/ci.yml).
 */
export default defineConfig({
	test: {
		include: ["server/**/*.test.ts"],
		environment: "node",
	},
});
