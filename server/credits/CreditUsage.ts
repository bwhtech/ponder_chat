import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlSchema from "effect/sql/SqlSchema";
import { RESEARCH_MODEL } from "../../shared/web-mode.ts";
import { byModel, lastDays } from "../admin/usage.ts";
import { WEB_SEARCH_FUNCTION_ID } from "../search/tool.ts";
import * as Settings from "../settings/Settings.ts";
import { COMPACTION_FUNCTION_ID } from "../telemetry/Runs.ts";
import { toCredits, utcDay } from "./Credits.ts";

const USAGE_DAYS = 30;

/** The charged calls that run around a reply: memory's gate and writer (memory/), and summaries of long chats. */
const MEMORY_AND_SUMMARY_FUNCTION_IDS: ReadonlyArray<string> = ["memory-gate", "memory-extract", COMPACTION_FUNCTION_ID];

const CostRow = Schema.Struct({ day: Schema.String, model: Schema.String, function_id: Schema.NullOr(Schema.String), usd: Schema.Number });
const UserSince = Schema.Struct({ user: Schema.String, since: Schema.Date });

const sumUsd = (rows: ReadonlyArray<{ usd: number }>) => rows.reduce((sum, row) => sum + row.usd, 0);

/**
 * The name a person sees for a charged call. A web search runs on a small model they never
 * picked, whose id byModel would read as the chat model it starts with ("z-ai/glm-5.3-flash"
 * as GLM 5.3). OpenRouter can answer with a dated id, for deep research too.
 */
function lineName({ model, function_id }: { model: string; function_id: string | null }) {
	if (function_id === WEB_SEARCH_FUNCTION_ID) return "Web search";
	return model === RESEARCH_MODEL.id || model.startsWith(`${RESEARCH_MODEL.id}-`) ? RESEARCH_MODEL.name : model;
}

/**
 * What a person sees of their own spending in Settings, Usage: credits per UTC day and what
 * used them, read from `charged_runs` (telemetry/Runs.ts). Credits, days and names only: no
 * dollars, and nothing about a chat.
 */
export const creditUsage = Effect.fn("CreditUsage.creditUsage")(function* (user: string) {
	const sql = yield* PgClient.PgClient;
	const { creditsPerUsd } = yield* Settings.Settings.use((settings) => settings.get);
	const dates = lastDays(USAGE_DAYS, utcDay(new Date(yield* Clock.currentTimeMillis)).start);
	const findCosts = SqlSchema.findAll({
		Request: UserSince,
		Result: CostRow,
		execute: ({ user, since }) => sql`
			select to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day, model, function_id,
				coalesce(sum(cost_usd), 0)::float8 as usd
			from charged_runs
			where "user" = ${user} and created_at >= ${since}
			group by 1, 2, 3`,
	});
	const rows = yield* findCosts({ user, since: new Date(`${dates[0]}T00:00:00Z`) }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
	const isMemoryOrSummary = (row: (typeof rows)[number]) => MEMORY_AND_SUMMARY_FUNCTION_IDS.includes(row.function_id ?? "");
	const named = rows.filter((row) => !isMemoryOrSummary(row)).map((row) => ({ model: lineName(row), usd: row.usd }));

	return {
		days: dates.map((date) => ({ date, credits: toCredits(sumUsd(rows.filter((row) => row.day === date)), creditsPerUsd) })),
		total: toCredits(sumUsd(rows), creditsPerUsd),
		// byModel rounds to whole credits; at ten times the rate its numbers are tenths, as every other credit figure here.
		models: byModel(named, creditsPerUsd * 10).map((row) => ({ model: row.model, credits: row.credits / 10 })),
		memoryAndSummaries: toCredits(sumUsd(rows.filter(isMemoryOrSummary)), creditsPerUsd),
	};
});
