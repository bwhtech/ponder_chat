import type { FileUIPart, UIMessage } from "ai";
import { reactive } from "vue";

/** A message the person wrote while the agent was working, with its uploaded files. */
export interface Queued {
	id: string;
	text: string;
	files: FileUIPart[];
	/** The skills the person chose with $name. */
	skills: string[];
}

/**
 * Each thread's queue, by thread id. Kept outside ChatView, so switching threads and
 * back keeps it; a reload clears it. ChatView sends the first item when the agent is free.
 */
const queues = reactive(new Map<string, Queued[]>());

export function queueFor(threadId: string): Queued[] {
	if (!queues.has(threadId)) queues.set(threadId, []);
	return queues.get(threadId)!;
}

/** The agent is waiting on the person: an approval, ask_user questions or a plan in its last message. */
export function waitingOnPerson(messages: UIMessage[]) {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return false;
	return last.parts.some((part) => {
		if (!("state" in part)) return false;
		if (part.state === "approval-requested") return true;
		return (part.type === "tool-ask_user" || part.type === "tool-propose_plan") && part.state === "input-available";
	});
}

const INTERRUPTED = "Stopped before it finished: the person sent a new message. The reply was cut off.";
const NOT_ANSWERED = "The person sent a new message instead of answering.";

/**
 * Closes what the last reply left open, before a new message goes out: an approval
 * nobody answered becomes a denial, and a tool call cut off by Stop or Steer becomes
 * an error. Without this the model gets a tool call with no result. ask_user and
 * propose_plan calls are left to ChatView, which closes them with addToolOutput.
 */
export function closeOpenCalls(messages: UIMessage[]): UIMessage[] | null {
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return null;
	let changed = false;
	const parts = last.parts.map((part) => {
		if (!("state" in part) || !("toolCallId" in part) || part.type === "tool-ask_user" || part.type === "tool-propose_plan") return part;
		if (part.state === "approval-requested") {
			changed = true;
			return { ...part, state: "output-denied", approval: { ...part.approval, approved: false, reason: NOT_ANSWERED } } as unknown as typeof part;
		}
		if (part.state === "input-streaming" || part.state === "input-available") {
			changed = true;
			return { ...part, state: "output-error", errorText: INTERRUPTED } as unknown as typeof part;
		}
		return part;
	});
	return changed ? [...messages.slice(0, -1), { ...last, parts }] : null;
}
