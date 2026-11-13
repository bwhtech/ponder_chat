import type { UIMessage } from "ai";

/**
 * Compaction in the chat (server/compaction/). When a chat gets too long for its model,
 * the reply first summarizes the older messages. Its `data-compaction` part says so:
 * "running" while the summary is written, then "done" with the last message it covers.
 */
const PART = "data-compaction";

type State = { state?: "running" | "done" | "failed"; through?: string };

/** The reply is writing a summary now: its last part is a running compaction. */
export function compacting(message: UIMessage | undefined) {
	const part = message?.role === "assistant" ? message.parts.at(-1) : undefined;
	return part?.type === PART && stateOf(part).state === "running";
}

/** The last message the newest summary covers. An older summary is part of the newer one, so only one divider shows. */
export function summarizedThrough(messages: UIMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const part = messages[i].parts.find((each) => each.type === PART);
		const { state, through } = part ? stateOf(part) : {};
		if (state === "done" && through) return through;
	}
	return undefined;
}

function stateOf(part: UIMessage["parts"][number]): State {
	return ((part as { data?: unknown }).data ?? {}) as State;
}
