import { sql } from "../db.ts";
import { decidedRequests, pendingCount, pendingRequests } from "../extra-credits.ts";
import { runPromise } from "../runtime/runtime.ts";
import * as Settings from "../settings/Settings.ts";
import { displayName, namesOf } from "./people.ts";
import { creditsByModel, limitsToday, Usage } from "./usage.ts";

/** The Overview page of /admin: today, the chosen range of days, models, and who uses Ponder. */
export async function overview(days: number) {
	const [usage, limits, byModel, accounts, pending, { creditsPerUsd }] = await Promise.all([
		Usage.load(Math.max(days, 2)),
		limitsToday(),
		creditsByModel(days),
		sql<{ id: string; name: string; email: string }[]>`select id, name, email from users`,
		pendingCount(),
		runPromise(Settings.Settings.use((settings) => settings.get)),
	]);
	const everyone = usage.everyone();
	const [yesterday, today] = everyone.slice(-2);
	const outOfCredits = usage.users().filter((user) => usage.day(user).credits >= limits.limit(user)).length;
	const people = accounts
		.map((account) => ({
			id: account.id,
			name: displayName(account.name, account.email),
			today: { used: usage.day(account.id).credits, limit: limits.limit(account.id) },
			...usage.total(account.id, days),
		}))
		.sort((a, b) => b.credits - a.credits);
	return {
		today: { active: today.active, replies: today.replies, credits: today.credits, outOfCredits },
		yesterday: { active: yesterday.active, replies: yesterday.replies },
		days: everyone.slice(-days),
		byModel,
		people,
		pendingRequests: pending,
		creditsPerUsd,
	};
}

/** The Requests page: requests waiting for an answer, and those answered in the last 30 days. */
export async function requestsReport() {
	const [pending, decided, usage, limits] = await Promise.all([pendingRequests(), decidedRequests(30), Usage.load(7), limitsToday()]);
	const ids = new Set([...pending.map((r) => r.user_id), ...decided.flatMap((r) => [r.user_id, r.decided_by])]);
	const names = await namesOf([...ids]);
	const personOf = (id: string) => names.get(id) ?? { id, name: "Removed account", email: "" };
	return {
		pending: pending.map((request) => ({
			id: request.id,
			createdAt: request.created_at.toISOString(),
			person: personOf(request.user_id),
			today: { used: usage.day(request.user_id).credits, limit: limits.limit(request.user_id) },
			/** What the approve dialog suggests: the person's usual daily limit. */
			dailyLimit: limits.own(request.user_id) ?? limits.defaultDailyCredits,
			week: usage.total(request.user_id, 7).credits,
		})),
		decided: decided.map((request) => ({
			id: request.id,
			createdAt: request.created_at.toISOString(),
			status: request.status,
			credits: request.credits,
			decidedAt: request.decided_at.toISOString(),
			person: personOf(request.user_id),
			decidedBy: personOf(request.decided_by).name,
		})),
	};
}
