import { fromBoot } from "./boot";
import { loadChatSdk } from "./lazy-chat";
import { loadTranscript } from "./transcript-parts";

/**
 * The code a chat needs beyond its first screen: the AI SDK, to send and stream, and the
 * transcript, to show replies. Loading it runs it too, and running it (KaTeX, highlight.js,
 * zod set themselves up) is a long task on a phone. So the page only downloads it once it has
 * loaded (prefetchChat), and runs it when it is about to be needed: when the person types, or
 * points at a chat (ChatView.vue, ThreadList.vue), or a chat with messages opens.
 */
export function preloadChat() {
	return Promise.all([loadChatSdk(), loadTranscript()]).catch(() => undefined);
}

/**
 * Downloads the chat's later code, without running it: the server lists its files (boot.ts).
 * Without the list (npm run dev), it loads the code instead.
 */
export function prefetchChat() {
	const files = fromBoot("prefetch");
	if (!files?.length) return void preloadChat();
	for (const href of files) {
		const link = document.createElement("link");
		link.rel = "prefetch";
		link.href = href;
		// As the import() that runs it later asks for it (cors), so it finds this copy.
		link.crossOrigin = "anonymous";
		if (href.endsWith(".js")) link.as = "script";
		else if (href.endsWith(".css")) link.as = "style";
		document.head.append(link);
	}
}

/** Runs `task` once the page has loaded (its font and pictures too) and the browser is idle. */
export function afterLoad(task: () => void) {
	const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(task, { timeout: 5000 }) : setTimeout(task, 500));
	if (document.readyState === "complete") idle();
	else addEventListener("load", idle, { once: true });
}
