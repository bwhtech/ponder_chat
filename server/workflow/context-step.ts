/** How many times a context step runs again after it fails. The same as Workflow's default, stated so the last attempt is known. */
export const CONTEXT_STEP_RETRIES = 3;

/**
 * Runs the work of a step that gathers context for a reply: memory, connectors, skills,
 * trusted pages. When the step fails, chat.ts writes the reply without it, so the failure
 * is logged here. The last failed attempt is logged as "reply degraded", and
 * deploy/sentinel.sh alerts on that line. It is logged in the step, not in the workflow,
 * because the workflow replays on every resume and would log the same failure again.
 */
export async function contextStep<T>(what: string, about: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		// Loaded here, as the steps load their modules: the workflow imports this file too.
		const { getStepMetadata } = await import("workflow");
		const { attempt } = getStepMetadata();
		const message = `${what} (${about}, attempt ${attempt} of ${CONTEXT_STEP_RETRIES + 1}): ${error instanceof Error ? error.message : String(error)}`;
		if (attempt > CONTEXT_STEP_RETRIES) console.error(`reply degraded: ${message}`);
		else console.warn(`reply step failed, will retry: ${message}`);
		throw error;
	}
}
