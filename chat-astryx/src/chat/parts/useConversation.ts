import type { UIMessage } from "ai";
import { useEffect, useRef, useState } from "react";
import { useAttention } from "../../lib/attention";
import { waitingOnPerson } from "../../lib/message-queue";
import { useRememberedNotes } from "../../lib/remembered-notes";
import { useThinking } from "../../lib/thinking";
import { chosenSkills, loadSkills } from "../../skills/skills";

// A long thread shows its latest messages first; older ones render only when asked for.
// The start always falls on the person's message, so no turn is cut.
const PAGE = 12;

/**
 * What the conversation shows around the messages: which messages are on screen, the
 * "Thinking" line, the memory notes under replies, and the tab's attention badge.
 */
export function useConversation({ threadId, initialMessages, messages, busy }: { threadId: string; initialMessages: UIMessage[]; messages: UIMessage[]; busy: boolean }) {
	const [firstShown, setFirstShown] = useState(() => turnStart(initialMessages, initialMessages.length - PAGE));
	const latest = useRef(messages);
	latest.current = messages;
	const showEarlier = () => setFirstShown((first) => turnStart(latest.current, first - PAGE));

	const notes = useRememberedNotes(threadId);
	const { load } = notes;
	useEffect(() => {
		void load();
		void loadSkills();
	}, [load]);
	// Memory saves after the reply: once a reply ends, load the notes again, and the server waits for the save.
	const wasBusy = useRef(busy);
	useEffect(() => {
		if (wasBusy.current && !busy) void load({ wait: true });
		wasBusy.current = busy;
	}, [busy, load]);

	// While the tab is hidden, a finished reply puts a count on the favicon.
	useAttention(busy, waitingOnPerson(messages));
	const { thinking, text: thinkingText } = useThinking(busy, messages);
	const last = messages.at(-1);

	return {
		shown: messages.slice(firstShown),
		/** How many messages are above the ones on screen. */
		hidden: firstShown,
		showEarlier,
		/** "Thinking" sits in the reply's place before the reply exists: the turn after the person's message. */
		thinkingAlone: thinking && last?.role !== "assistant",
		/** "Thinking" under the reply being written, between its steps. */
		thinkingAfter: (message: UIMessage) => thinking && message === last && message.role === "assistant",
		thinkingText,
		notes,
		/** The skills the person asked for in the message this reply answers, for the line above the reply. */
		askedSkills: (message: UIMessage) => (message.role === "assistant" ? chosenSkills(messages[messages.indexOf(message) - 1]) : []),
	};
}

/** The index of the person's message that starts the turn holding `index`; 0 at the top. */
function turnStart(list: UIMessage[], index: number) {
	let start = Math.max(0, index);
	while (start > 0 && list[start]?.role !== "user") start--;
	return start;
}
