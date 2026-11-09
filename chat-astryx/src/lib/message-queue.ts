import type { FileUIPart, UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { citationLabel, type Citation } from "../cite/citations";
import { createStore, useStore } from "./store";

/** A message the person wrote while the agent was working, with its uploaded files. */
export interface Queued {
	id: string;
	text: string;
	files: FileUIPart[];
	/** The skills the person chose with $name. */
	skills: string[];
	/** Text quoted from earlier replies (cite/). */
	citations: Citation[];
}

/** A queued message as the list above the field shows it. */
export type QueuedRow = { id: string; text: string; files: number };

/**
 * Each thread's queue, by thread id. Kept outside ChatView, so switching threads and
 * back keeps it; a reload clears it. ChatView sends the first item when the agent is free.
 */
const queues = createStore<Record<string, Queued[]>>({});
const NONE: Queued[] = [];

function queueOf(threadId: string) {
	return queues.get()[threadId] ?? NONE;
}

function setQueue(threadId: string, change: (queue: Queued[]) => Queued[]) {
	queues.set((all) => ({ ...all, [threadId]: change(all[threadId] ?? NONE) }));
}

type QueueOptions = {
	/** A reply is on its way: a new message waits. */
	busy: boolean;
	/** The chat can send now: no reply, no error. */
	ready: boolean;
	/** No credits: the queue waits until they come back. */
	outOfCredits: boolean;
	/** Sends one message now. */
	send: (item: Queued) => Promise<unknown> | unknown;
	/** Stops the reply on its way. */
	stopReply: () => Promise<unknown>;
};

/**
 * One chat's queue, with its rules: a message written during a reply waits, and the
 * first one goes out when the reply ends. It does not go out after an error, without
 * credits, while the person edits it, or after Stop, so the queue does not send what
 * they may no longer want. Sending or Steer starts it again.
 */
export function useMessageQueue(threadId: string, options: QueueOptions) {
	const queue = useStore(queues)[threadId] ?? NONE;
	const [paused, setPaused] = useState(false);
	/** The id of the queued message the person is editing. */
	const [editing, setEditing] = useState<string | null>(null);
	const latest = useRef({ options, paused, editing });
	latest.current = { options, paused, editing };

	const items: QueuedRow[] = queue.map((item) => ({
		id: item.id,
		text: item.text || [...item.skills.map((name) => `$${name}`), ...item.citations.map((citation) => `“${citationLabel(citation)}”`)].join(" "),
		files: item.files.length,
	}));

	const sendNow = useCallback(async (item: Queued) => {
		setPaused(false);
		await latest.current.options.send(item);
	}, []);

	/** While a reply is on its way, the message waits; otherwise it goes out now. */
	async function send(item: Queued) {
		if (options.busy) setQueue(threadId, (list) => [...list, item]);
		else await sendNow(item);
	}

	function take(id: string) {
		const item = queueOf(threadId).find((queued) => queued.id === id);
		if (item) setQueue(threadId, (list) => list.filter((queued) => queued.id !== id));
		return item;
	}

	/** Steer: stop the reply on its way and send this message now. */
	async function steer(id: string) {
		const item = take(id);
		if (!item) return;
		if (options.busy) await options.stopReply();
		await sendNow(item);
	}

	function stop() {
		if (queue.length) setPaused(true);
		void options.stopReply();
	}

	function update(id: string, text: string) {
		setQueue(threadId, (list) => list.map((item) => (item.id === id ? { ...item, text } : item)));
	}

	function reorder(ids: string[]) {
		setQueue(threadId, (list) => {
			const byId = new Map(list.map((item) => [item.id, item]));
			return ids.map((id) => byId.get(id)).filter((item): item is Queued => Boolean(item));
		});
	}

	// The status settles a tick after a reply ends, so the check runs again then.
	useEffect(() => {
		const next = () => {
			const { options, paused, editing } = latest.current;
			const first = queueOf(threadId)[0];
			return options.ready && first && !paused && !options.outOfCredits && first.id !== editing ? first : null;
		};
		if (!next()) return;
		const timer = setTimeout(() => {
			const first = next();
			if (!first) return;
			setQueue(threadId, (list) => list.filter((item) => item !== first));
			void sendNow(first);
		});
		return () => clearTimeout(timer);
	}, [options.ready, queue.length, options.outOfCredits, editing, paused, threadId, sendNow]);

	return { items, editing, setEditing, send, steer, stop, remove: take, update, reorder };
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
