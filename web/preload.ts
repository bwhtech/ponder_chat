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
 * The list also has what a first tap waits for (settings, memory, the side panel, a dialog, the
 * model menu), and for an admin the /admin page's files, so those open from the cache.
 * Without the list (npm run dev), it loads the chat's later code instead.
 */
export function prefetchChat() {
	const files = fromBoot("prefetch");
	if (!files?.length) return void preloadChat();
	// Safari has no <link rel="prefetch">. There the files are fetched into the HTTP cache, one
	// at a time at low priority, so they don't compete with anything the person asks for. The
	// assets are immutable, so the later import() finds the copy.
	if (!document.createElement("link").relList.supports?.("prefetch")) return void warmCache(files);
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

async function warmCache(files: string[]) {
	for (const href of files) {
		try {
			const response = await fetch(href, { mode: "cors", credentials: "same-origin", priority: "low" } as RequestInit);
			await response.arrayBuffer();
		} catch {
			// Only a head start: the import() that needs the file fetches it again.
		}
	}
}

/** Runs `task` once the page has loaded (its font and pictures too) and the browser is idle. */
export function afterLoad(task: () => void) {
	const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(task, { timeout: 5000 }) : setTimeout(task, 500));
	if (document.readyState === "complete") idle();
	else addEventListener("load", idle, { once: true });
}
