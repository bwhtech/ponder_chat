import { defineConfig, devices } from "@playwright/test";
import { e2e } from "./e2e/env.ts";

/**
 * The end-to-end tests (e2e/README.md): a real browser on Ponder's build, with a real
 * Postgres and a fake OpenRouter. `npm run e2e` builds Ponder and runs them.
 */
export default defineConfig({
	testDir: "e2e/tests",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: e2e.baseUrl,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /phone\.spec/ },
		{ name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /phone\.spec/ },
	],
	// A new database, the fake OpenRouter and Ponder (e2e/start.ts). A server started by
	// hand with `npx tsx e2e/start.ts` is used as it is.
	webServer: {
		command: "npx tsx e2e/start.ts",
		url: `${e2e.baseUrl}/health`,
		wait: { stdout: /Ponder Chat is ready/ },
		reuseExistingServer: !process.env.CI,
		stdout: "pipe",
		timeout: 120_000,
	},
});
