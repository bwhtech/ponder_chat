import type { UIMessage } from "ai";
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { compacting } from "./compaction";
import { waitingOnPerson } from "./message-queue";
import { latestWebChoice } from "../shared/web-mode";

/**
 * "Thinking" while a reply is on its way and nothing else on screen moves. Text and
 * reasoning that stream, and a running tool ("Searching …"), show it themselves. Every
 * other moment shows it: before the first word (a model can think for 20 seconds before
 * it writes), after a tool returns, and between steps. It shows after a short quiet, so it
 * does not blink between the last word and the end of the run, and a long wait counts the
 * seconds, so it reads as work going on, not as stuck.
 *
 * Call from a chat's setup, or later in its scope (ChatView.vue starts it with the first reply).
 *
 * Text that stops streaming for a moment counts as quiet too. A model that writes a tool
 * call can send nothing for many seconds after its last word, while the text part still
 * reads "streaming".
 */
export function useThinking(busy: Ref<boolean>, messages: Ref<UIMessage[]>) {
	const stalled = useStalled(() => lastText(messages.value.at(-1)));
	const quiet = computed(() => busy.value && !waitingOnPerson(messages.value) && (!moving(messages.value.at(-1)) || stalled.value));
	const thinking = ref(false);
	const seconds = ref(0);
	let showTimer: ReturnType<typeof setTimeout> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	const clear = () => {
		clearTimeout(showTimer);
		clearInterval(tickTimer);
	};

	watch(
		quiet,
		(now) => {
			clear();
			thinking.value = false;
			if (!now) return;
			showTimer = setTimeout(() => {
				thinking.value = true;
				seconds.value = 0;
				tickTimer = setInterval(() => seconds.value++, 1_000);
			}, 300);
		},
		{ immediate: true },
	);
	onScopeDispose(clear);

	// While the reply summarizes a long chat first (compaction.ts), it says so. Deep research searches for minutes before its first word.
	const doing = computed(() =>
		compacting(messages.value.at(-1)) ? "Compacting earlier messages" : latestWebChoice(messages.value)?.web === "research" ? "Researching" : "Thinking",
	);
	const text = computed(() => (seconds.value >= 5 ? `${doing.value} for ${duration(seconds.value)}` : doing.value));
	return { thinking, text };
}

/** 42s, then 4m 05s: research waits for minutes. */
function duration(seconds: number) {
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The last message shows movement itself: text or reasoning that streams, or a tool that runs. */
function moving(last: UIMessage | undefined) {
	if (last?.role !== "assistant") return false;
	const part = last.parts.at(-1);
	if (!part) return false;
	if (part.type === "text" || part.type === "reasoning") return part.state === "streaming";
	if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
		const state = (part as { state?: string }).state;
		return state === "input-streaming" || state === "input-available";
	}
	return false;
}

const STALL_MS = 1_500;

/** True when `value` is set and has not changed for STALL_MS. */
function useStalled(value: () => string | undefined) {
	const stalled = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	watch(
		value,
		(now) => {
			clearTimeout(timer);
			stalled.value = false;
			if (now !== undefined) timer = setTimeout(() => (stalled.value = true), STALL_MS);
		},
		{ immediate: true },
	);
	onScopeDispose(() => clearTimeout(timer));
	return stalled;
}

/** The text that streams at the end of the reply, with its place, so a new part counts as a change. */
function lastText(last: UIMessage | undefined) {
	const part = last?.role === "assistant" ? last.parts.at(-1) : undefined;
	if (part?.type !== "text" || part.state !== "streaming") return undefined;
	return `${last!.parts.length}:${part.text.length}`;
}
