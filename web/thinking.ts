import type { UIMessage } from "ai";
import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { waitingOnPerson } from "./message-queue";

/**
 * "Thinking" while a reply is on its way and nothing else on screen moves. Text and
 * reasoning that stream, and a running tool ("Searching …"), show it themselves. Every
 * other moment shows it: before the first word (a model can think for 20 seconds before
 * it writes), after a tool returns, and between steps. It shows after a short quiet, so it
 * does not blink between the last word and the end of the run, and a long wait counts the
 * seconds, so it reads as work going on, not as stuck.
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
	onBeforeUnmount(clear);

	const text = computed(() => (seconds.value >= 5 ? `Thinking for ${seconds.value}s` : "Thinking"));
	return { thinking, text };
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
	onBeforeUnmount(() => clearTimeout(timer));
	return stalled;
}

/** The text that streams at the end of the reply, with its place, so a new part counts as a change. */
function lastText(last: UIMessage | undefined) {
	const part = last?.role === "assistant" ? last.parts.at(-1) : undefined;
	if (part?.type !== "text" || part.state !== "streaming") return undefined;
	return `${last!.parts.length}:${part.text.length}`;
}
