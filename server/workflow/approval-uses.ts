import { sql } from "../db.ts";
import type { Answer } from "./answered-again.ts";

/**
 * Each approval the person answered, once a run was started to carry it out: the durable
 * fact that the answer was used. A second answer to the same request (another tab, a
 * resend, an old card after Stop or Retry) starts nothing (replies.ts).
 *
 * The row is written before the run starts, so before the call it approves can reach an
 * app. Neither Stop, a failed run, Retry nor a saved reply that changes removes it: only
 * deleting the thread does.
 */
export async function migrateApprovalUses() {
	await sql`
		create table if not exists approval_uses (
			thread_id text not null,
			approval_id text not null,
			tool_call_id text not null,
			approved boolean not null,
			run_id text,
			used_at timestamptz not null default now(),
			primary key (thread_id, approval_id)
		)`;
}

/**
 * Records the answers as used. True when none of them was used before; then all of them
 * are recorded. False when one was: then none is.
 */
export async function useApprovals(threadId: string, answers: Answer[]): Promise<boolean> {
	return sql
		.begin(async (tx) => {
			for (const answer of answers) {
				const [row] = await tx`
					insert into approval_uses (thread_id, approval_id, tool_call_id, approved)
					values (${threadId}, ${answer.approvalId}, ${answer.toolCallId}, ${answer.approved})
					on conflict do nothing returning approval_id`;
				if (!row) throw new AlreadyUsed();
			}
			return true;
		})
		.catch((error) => {
			if (error instanceof AlreadyUsed) return false;
			throw error;
		});
}

/** The run that carries the answers out, once it has an id. */
export async function approvalsUsedBy(threadId: string, answers: Answer[], runId: string) {
	await sql`update approval_uses set run_id = ${runId} where thread_id = ${threadId} and approval_id in ${sql(answers.map((answer) => answer.approvalId))}`;
}

/** The run could not start: the answers were not used, and can be sent again. */
export async function releaseApprovals(threadId: string, answers: Answer[]) {
	await sql`delete from approval_uses where thread_id = ${threadId} and approval_id in ${sql(answers.map((answer) => answer.approvalId))} and run_id is null`;
}

/** For a deleted thread. */
export async function forgetApprovalUses(threadId: string) {
	await sql`delete from approval_uses where thread_id = ${threadId}`;
}

class AlreadyUsed extends Error {}
