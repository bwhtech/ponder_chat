import { sql } from "./db.ts";

/**
 * Extra credits. A person who has used today's credits can ask the admins for more
 * (POST /api/credits/request). An admin approves with a number of credits, or declines
 * (/admin, Requests). An admin can also give credits without a request. A grant adds to
 * the limit of one UTC day only: the next day starts on the usual limit again.
 *
 * A person has at most one pending request at a time. After an answer they can ask again.
 * A request that is still pending at midnight UTC stays pending, and an approval gives
 * credits for the day of the approval.
 */
export type RequestStatus = "pending" | "approved" | "declined";
export type CreditRequest = { status: RequestStatus; createdAt: string; credits: number | null };
export type Decision = { status: "approved"; credits: number } | { status: "declined" };

export async function migrateExtraCredits() {
	await sql`
		create table if not exists credit_requests (
			id integer primary key generated always as identity,
			user_id text not null,
			created_at timestamptz not null default now(),
			status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
			decided_by text,
			decided_at timestamptz,
			credits integer
		)`;
	await sql`create unique index if not exists credit_requests_one_pending on credit_requests (user_id) where status = 'pending'`;
	await sql`create index if not exists credit_requests_user on credit_requests (user_id, created_at desc)`;
	// The answered requests on /admin, Requests, newest first.
	await sql`create index if not exists credit_requests_decided on credit_requests (decided_at desc) where status <> 'pending'`;
	await sql`
		create table if not exists credit_grants (
			id integer primary key generated always as identity,
			user_id text not null,
			day date not null,
			credits integer not null check (credits > 0),
			granted_by text not null,
			request_id integer,
			created_at timestamptz not null default now()
		)`;
	await sql`create index if not exists credit_grants_user_day on credit_grants (user_id, day)`;
	// Everyone's grants for one day: the limits on /admin and in deploy/sentinel.sh.
	await sql`create index if not exists credit_grants_day on credit_grants (day)`;
}

/** Extra credits a person got for one UTC day ("2026-11-05"). */
export async function extraCredits(user: string, day: string) {
	const [row] = await sql<{ credits: number }[]>`
		select coalesce(sum(credits), 0)::int as credits from credit_grants where user_id = ${user} and day = ${day}`;
	return row.credits;
}

/** What the chat page shows: the pending request, or the latest one answered since `since`. */
export async function currentRequest(user: string, since: Date): Promise<CreditRequest | null> {
	const [row] = await sql<{ status: RequestStatus; created_at: Date; credits: number | null }[]>`
		select status, created_at, credits from credit_requests
		where user_id = ${user} and (status = 'pending' or decided_at >= ${since})
		order by created_at desc limit 1`;
	return row ? { status: row.status, createdAt: row.created_at.toISOString(), credits: row.credits } : null;
}

/** A new request, or null when one is already waiting. */
export async function askForCredits(user: string) {
	const [row] = await sql<{ id: number }[]>`
		insert into credit_requests (user_id) values (${user})
		on conflict (user_id) where status = 'pending' do nothing
		returning id`;
	return row ?? null;
}

/** Answers a pending request. Returns the person's id, or null when it was answered already. */
export async function decideRequest(id: number, decision: Decision, by: string) {
	const credits = decision.status === "approved" ? decision.credits : null;
	return sql.begin(async (tx) => {
		const [request] = await tx<{ user_id: string }[]>`
			update credit_requests set status = ${decision.status}, credits = ${credits}, decided_by = ${by}, decided_at = now()
			where id = ${id} and status = 'pending'
			returning user_id`;
		if (!request) return null;
		if (credits) {
			await tx`
				insert into credit_grants (user_id, day, credits, granted_by, request_id)
				values (${request.user_id}, (now() at time zone 'utc')::date, ${credits}, ${by}, ${id})`;
		}
		return request.user_id;
	});
}

/** Extra credits for today without a request. */
export async function grantCredits(user: string, credits: number, by: string) {
	await sql`
		insert into credit_grants (user_id, day, credits, granted_by)
		values (${user}, (now() at time zone 'utc')::date, ${credits}, ${by})`;
}

export async function pendingRequests() {
	return sql<{ id: number; user_id: string; created_at: Date }[]>`
		select id, user_id, created_at from credit_requests where status = 'pending' order by created_at`;
}

export async function decidedRequests(days = 30) {
	return sql<{ id: number; user_id: string; created_at: Date; status: Decision["status"]; credits: number | null; decided_by: string; decided_at: Date }[]>`
		select id, user_id, created_at, status, credits, decided_by, decided_at from credit_requests
		where status <> 'pending' and decided_at > now() - make_interval(days => ${days})
		order by decided_at desc`;
}

export async function pendingCount() {
	const [row] = await sql<{ count: number }[]>`select count(*)::int as count from credit_requests where status = 'pending'`;
	return row.count;
}
