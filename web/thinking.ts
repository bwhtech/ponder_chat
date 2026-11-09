import type { UIMessage } from "ai";
import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { waitingOnPerson } from "./message-queue";

/**
 * "Thinking…" while a reply is on its way and nothing else on screen moves. Text and
 * reasoning that stream, and a running tool ("Searching …"), show it themselves. Every
 * other moment shows it: before the first word (a model can think for 20 seconds before
 * it writes), after a tool returns, and between steps. It shows after a short quiet, so it
 * does not blink between the last word and the end of the run, and a long wait counts the
 * seconds, so it reads as work going on, not as stuck.
 */
export function useThinking(busy: Ref<boolean>, messages: Ref<UIMessage[]>) {
	const quiet = computed(() => busy.value && !waitingOnPerson(messages.value) && !moving(messages.value.at(-1)));
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

	const text = computed(() => (seconds.value >= 5 ? `Thinking… ${seconds.value}s` : "Thinking…"));
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
