import { defineConfig } from "vitest/config";

/**
 * The unit tests (npm run test): the server's, server/**\/*.test.ts, with @effect/vitest,
 * and a few of plain web code that needs no browser, web/**\/*.test.ts. e2e/ is Playwright's.
 *
 * Tests that need Postgres run only when TEST_DATABASE_URL is set, and skip otherwise.
 * It is its own variable, not DATABASE_URL, so a shell with Ponder's real database in its
 * environment never runs them there. They make their own rows and tables and delete them.
 * CI runs them in the e2e job, on its Postgres (.github/workflows/ci.yml).
 */
export default defineConfig({
	test: {
		include: ["server/**/*.test.ts", "web/**/*.test.ts"],
		environment: "node",
	},
});
