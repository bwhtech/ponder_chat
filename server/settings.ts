import { sql } from "./db.ts";

/**
 * App-wide settings that admins change on /admin: one row in `settings`. On the first
 * start it is filled from CHAT_DAILY_CREDITS and CHAT_CREDITS_PER_USD, so a deploy keeps
 * the limits it had. After that the table wins and the two variables are not read.
 *
 * Every reply reads the settings (credits.ts), so they are kept for a few seconds.
 * A change from /admin shows at once in this process.
 */
export type Settings = {
	/** Credits a day for each person without their own limit. */
	defaultDailyCredits: number;
	/** Credits per US dollar of OpenRouter cost. With 1000, one credit is $0.001. */
	creditsPerUsd: number;
	/**
	 * A model that can't read PDFs gets the text this server read from them (file-context.ts).
	 * Off: every PDF goes to the model, and OpenRouter parses it for those that can't.
	 */
	pdfTextOnServer: boolean;
};

export type CreditSettings = Pick<Settings, "defaultDailyCredits" | "creditsPerUsd">;

const CACHE_MS = 5_000;
let cached: { settings: Settings; at: number } | undefined;

export async function migrateSettings() {
	await sql`
		create table if not exists settings (
			id integer primary key default 1 check (id = 1),
			default_daily_credits integer not null,
			credits_per_usd integer not null,
			updated_by text,
			updated_at timestamptz not null default now()
		)`;
	await sql`
		insert into settings (id, default_daily_credits, credits_per_usd)
		values (1, ${fromEnv("CHAT_DAILY_CREDITS", 1000)}, ${fromEnv("CHAT_CREDITS_PER_USD", 1000)})
		on conflict (id) do nothing`;
	await sql`alter table settings add column if not exists pdf_text_on_server boolean not null default true`;
}

export async function getSettings(): Promise<Settings> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;
	const [row] = await sql<{ default_daily_credits: number; credits_per_usd: number; pdf_text_on_server: boolean }[]>`
		select default_daily_credits, credits_per_usd, pdf_text_on_server from settings where id = 1`;
	const settings = { defaultDailyCredits: row.default_daily_credits, creditsPerUsd: row.credits_per_usd, pdfTextOnServer: row.pdf_text_on_server };
	cached = { settings, at: Date.now() };
	return settings;
}

export async function updateSettings(settings: CreditSettings, by: string) {
	await sql`
		update settings set default_daily_credits = ${settings.defaultDailyCredits}, credits_per_usd = ${settings.creditsPerUsd},
			updated_by = ${by}, updated_at = now()
		where id = 1`;
	cached = undefined;
}

export async function setPdfTextOnServer(on: boolean, by: string) {
	await sql`update settings set pdf_text_on_server = ${on}, updated_by = ${by}, updated_at = now() where id = 1`;
	cached = undefined;
}

/** A whole number from the environment, for the first start only. */
function fromEnv(name: string, fallback: number) {
	const value = Math.round(Number(process.env[name] ?? fallback));
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}
