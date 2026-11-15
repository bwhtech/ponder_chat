import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "../config.ts";

/**
 * App-wide settings that admins change on /admin: one row in `settings`. On the first
 * start it is filled from CHAT_DAILY_CREDITS and CHAT_CREDITS_PER_USD, so a deploy keeps
 * the limits it had. After that the table wins and the two variables are not read.
 *
 * Every reply reads the settings (credits.ts), so they are kept for a few seconds.
 * A change from /admin shows at once in this process.
 */
export type AppSettings = {
	/** Credits a day for each person without their own limit. */
	defaultDailyCredits: number;
	/** Credits per US dollar of OpenRouter cost. With 1000, one credit is $0.001. */
	creditsPerUsd: number;
	/**
	 * A model that can't read PDFs gets the text this server read from them (file-context.ts).
	 * Off: every PDF goes to the model, and OpenRouter parses it for those that can't.
	 */
	pdfTextOnServer: boolean;
	/** The model that writes the summary when a chat gets too long (compaction/summarize.ts). */
	compactionModel: string;
	/** How much Auto may spend on a request (models/AutoRouter.ts). */
	autoCostTier: AutoCostTier;
};

export const AUTO_COST_TIERS = ["low", "medium", "high"] as const;
export type AutoCostTier = (typeof AUTO_COST_TIERS)[number];

/** Cheap, with a 1M-token window on every private (ZDR) endpoint. */
export const DEFAULT_COMPACTION_MODEL = "deepseek/deepseek-v4.1-flash";

export type CreditSettings = Pick<AppSettings, "defaultDailyCredits" | "creditsPerUsd">;

const CACHE_MS = 5_000;

const SettingsRow = Schema.Struct({
	default_daily_credits: Schema.Number,
	credits_per_usd: Schema.Number,
	pdf_text_on_server: Schema.Boolean,
	compaction_model: Schema.NullOr(Schema.String),
	auto_cost_tier: Schema.Literals(AUTO_COST_TIERS),
});

export class Settings extends Context.Service<
	Settings,
	{
		/** Creates and updates the table, and fills it on the first start. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The settings, kept for 5 seconds. */
		readonly get: Effect.Effect<AppSettings, SqlError>;
		readonly update: (settings: CreditSettings, by: string) => Effect.Effect<void, SqlError>;
		readonly setPdfTextOnServer: (on: boolean, by: string) => Effect.Effect<void, SqlError>;
		readonly setCompactionModel: (model: string, by: string) => Effect.Effect<void, SqlError>;
		readonly setAutoCostTier: (tier: AutoCostTier, by: string) => Effect.Effect<void, SqlError>;
	}
>()("ponder/settings/Settings") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const config = yield* PonderConfig.PonderConfig;
	const cached = yield* Ref.make(Option.none<{ settings: AppSettings; at: number }>());

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists settings (
				id integer primary key default 1 check (id = 1),
				default_daily_credits integer not null,
				credits_per_usd integer not null,
				updated_by text,
				updated_at timestamptz not null default now()
			)`;
		// CHAT_DAILY_CREDITS and CHAT_CREDITS_PER_USD, for the first start only (config.ts parses them).
		yield* sql`
			insert into settings (id, default_daily_credits, credits_per_usd)
			values (1, ${config.dailyCredits}, ${config.creditsPerUsd})
			on conflict (id) do nothing`;
		yield* sql`alter table settings add column if not exists pdf_text_on_server boolean not null default true`;
		yield* sql`alter table settings add column if not exists compaction_model text`;
		yield* sql`alter table settings add column if not exists auto_cost_tier text not null default 'medium'`;
	});

	const findSettings = SqlSchema.findOneOption({
		Request: Schema.Void,
		Result: SettingsRow,
		execute: () => sql`select default_daily_credits, credits_per_usd, pdf_text_on_server, compaction_model, auto_cost_tier from settings where id = 1`,
	});

	// No span of its own: every reply reads the settings, nearly always from the cache.
	const get = Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		const known = yield* Ref.get(cached);
		if (Option.isSome(known) && now - known.value.at < CACHE_MS) return known.value.settings;
		// The row is made by migrate, before the server answers. Without it, or with a value
		// that does not decode, the database is not Ponder's: a defect.
		const row = yield* findSettings(undefined).pipe(Effect.flatMap(Effect.fromOption), Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }));
		const settings: AppSettings = {
			defaultDailyCredits: row.default_daily_credits,
			creditsPerUsd: row.credits_per_usd,
			pdfTextOnServer: row.pdf_text_on_server,
			compactionModel: row.compaction_model ?? DEFAULT_COMPACTION_MODEL,
			autoCostTier: row.auto_cost_tier,
		};
		yield* Ref.set(cached, Option.some({ settings, at: yield* Clock.currentTimeMillis }));
		return settings;
	});

	const forget = Ref.set(cached, Option.none());

	const update = Effect.fn("Settings.update")(function* (settings: CreditSettings, by: string) {
		yield* sql`
			update settings set default_daily_credits = ${settings.defaultDailyCredits}, credits_per_usd = ${settings.creditsPerUsd},
				updated_by = ${by}, updated_at = now()
			where id = 1`;
		yield* forget;
	});

	const setPdfTextOnServer = Effect.fn("Settings.setPdfTextOnServer")(function* (on: boolean, by: string) {
		yield* sql`update settings set pdf_text_on_server = ${on}, updated_by = ${by}, updated_at = now() where id = 1`;
		yield* forget;
	});

	const setCompactionModel = Effect.fn("Settings.setCompactionModel")(function* (model: string, by: string) {
		yield* sql`update settings set compaction_model = ${model}, updated_by = ${by}, updated_at = now() where id = 1`;
		yield* forget;
	});

	const setAutoCostTier = Effect.fn("Settings.setAutoCostTier")(function* (tier: AutoCostTier, by: string) {
		yield* sql`update settings set auto_cost_tier = ${tier}, updated_by = ${by}, updated_at = now() where id = 1`;
		yield* forget;
	});

	return Settings.of({ migrate, get, update, setPdfTextOnServer, setCompactionModel, setAutoCostTier });
});

export const layer = Layer.effect(Settings, make);
