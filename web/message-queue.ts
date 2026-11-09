import type { FileUIPart, UIMessage } from "ai";
import { computed, reactive, ref, watch, type Ref } from "vue";
import { citationLabel, type Citation } from "./cite/citations";

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

/**
 * Each thread's queue, by thread id. Kept outside ChatView, so switching threads and
 * back keeps it; a reload clears it. ChatView sends the first item when the agent is free.
 */
const queues = reactive(new Map<string, Queued[]>());

function queueFor(threadId: string): Queued[] {
	if (!queues.has(threadId)) queues.set(threadId, []);
	return queues.get(threadId)!;
}

type QueueOptions = {
	/** A reply is on its way: a new message waits. */
	busy: Ref<boolean>;
	/** The chat can send now: no reply, no error. */
	ready: Ref<boolean>;
	/** No credits: the queue waits until they come back. */
	outOfCredits: Ref<boolean>;
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
	const queue = queueFor(threadId);
	const paused = ref(false);
	/** The id of the queued message the person is editing. */
	const editing = ref<string | null>(null);
	const items = computed(() =>
		queue.map((item) => ({ id: item.id, text: item.text || [...item.skills.map((name) => `$${name}`), ...item.citations.map((citation) => `“${citationLabel(citation)}”`)].join(" "), files: item.files.length })),
	);

	/** While a reply is on its way, the message waits; otherwise it goes out now. */
	async function send(item: Queued) {
		if (options.busy.value) queue.push(item);
		else await sendNow(item);
	}

	async function sendNow(item: Queued) {
		paused.value = false;
		await options.send(item);
	}

	/** Steer: stop the reply on its way and send this message now. */
	async function steer(id: string) {
		const item = remove(id);
		if (!item) return;
		if (options.busy.value) await options.stopReply();
		await sendNow(item);
	}

	function stop() {
		if (queue.length) paused.value = true;
		void options.stopReply();
	}

	function remove(id: string) {
		const index = queue.findIndex((item) => item.id === id);
		return index === -1 ? undefined : queue.splice(index, 1)[0];
	}

	function update(id: string, text: string) {
		const item = queue.find((queued) => queued.id === id);
		if (item) item.text = text;
	}

	function reorder(ids: string[]) {
		const byId = new Map(queue.map((item) => [item.id, item]));
		queue.splice(0, queue.length, ...ids.map((id) => byId.get(id)!).filter(Boolean));
	}

	// The status settles a tick after a reply ends, so the check runs again then.
	const canSendNext = () => options.ready.value && queue.length > 0 && !paused.value && !options.outOfCredits.value && queue[0].id !== editing.value;
	watch(
		() => [options.ready.value, queue.length, options.outOfCredits.value, editing.value] as const,
		() => {
			if (canSendNext()) setTimeout(() => canSendNext() && void sendNow(queue.shift()!));
		},
		{ immediate: true },
	);

	return { items, editing, send, steer, stop, remove, update, reorder };
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
