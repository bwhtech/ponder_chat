/** Where the end-to-end tests run: shared by start.ts, playwright.config.ts and the fixtures. */
const port = Number(process.env.E2E_PORT ?? 3597);
const fakePort = Number(process.env.E2E_FAKE_PORT ?? 3598);

export const e2e = {
	port,
	fakePort,
	baseUrl: `http://127.0.0.1:${port}`,
	fakeUrl: `http://127.0.0.1:${fakePort}`,
	databaseUrl: process.env.E2E_DATABASE_URL ?? "postgres://ponder:ponder@127.0.0.1:55433/ponder_e2e",
};
