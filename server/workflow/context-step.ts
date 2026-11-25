/** How many times a context read runs again after it fails. The same as Workflow's default step retries, as when each read was a step. */
export const CONTEXT_STEP_RETRIES = 3;

/** The wait before each retry: 0.5 s, 1 s, 2 s. */
const retryDelay = (attempt: number) => 500 * 2 ** (attempt - 1);

/**
 * Runs one read that gathers context for a reply (memory, connectors, skills, trusted
 * pages, the workspace) inside turnContextStep (steps.ts). It tries again after a
 * failure; after the last attempt the reply is written without it, so the failure is
 * logged here as "reply degraded", and deploy/sentinel.sh alerts on that line. It is
 * logged in the step, not in the workflow, because the workflow replays on every resume
 * and would log the same failure again.
 */
export async function gatherContext<T>(what: string, about: string, fallback: T, work: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await work();
		} catch (error) {
			const message = `${what} (${about}, attempt ${attempt} of ${CONTEXT_STEP_RETRIES + 1}): ${error instanceof Error ? error.message : String(error)}`;
			// The console, not Effect's logger: this function is in the workflow's bundle, which
			// must not load the runtime. Effect's logger writes the same lines to it.
			if (attempt > CONTEXT_STEP_RETRIES) {
				console.error(`reply degraded: ${message}`);
				return fallback;
			}
			console.warn(`reply step failed, will retry: ${message}`);
			await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
		}
	}
}
