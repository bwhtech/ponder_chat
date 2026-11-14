import { loadChatSdk } from "./lazy-chat";
import { loadTranscript } from "./transcript-parts";

/**
 * The code a chat needs beyond its first screen: the AI SDK, to send and stream, and the
 * transcript, to show replies. Loaded ahead, so a message sent or a chat opened rarely waits.
 */
export function preloadChat() {
	return Promise.all([loadChatSdk(), loadTranscript()]).catch(() => undefined);
}

/** Runs `task` once the page has loaded (its font and pictures too) and the browser is idle. */
export function afterLoad(task: () => void) {
	const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(task, { timeout: 5000 }) : setTimeout(task, 500));
	if (document.readyState === "complete") idle();
	else addEventListener("load", idle, { once: true });
}
