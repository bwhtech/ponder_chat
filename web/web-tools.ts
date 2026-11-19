import type { UIMessage } from "ai";
import { computed, ref } from "vue";
import { keptMode, latestWebChoice, webChoiceOf, type KeptWebMode, type WebChoice } from "../shared/web-mode";
import { isRecord } from "./json";

/**
 * Web and Research under a message box (WebTools.vue), and the choice each message carries
 * (shared/web-mode.ts).
 *
 * Web stays as set for the chat. A chat in a workspace starts with it off, so replies come
 * from the workspace's Sources only; any other chat starts with it on. Research is for the
 * message being written only: it is slow and costs more, so it goes off once that message is sent.
 */
export function useWebTools(inWorkspace: () => boolean, saved?: WebChoice) {
	const usual = (): KeptWebMode => (inWorkspace() ? "off" : "search");
	// Null until the person, or a saved message, chooses: a new chat follows its workspace picker.
	const picked = ref<KeptWebMode | null>(saved ? keptMode(saved, usual()) : null);
	const kept = computed(() => picked.value ?? usual());
	const research = ref(false);

	return {
		/** What the chat stays on. */
		kept,
		web: computed({ get: () => kept.value === "search", set: (on: boolean) => (picked.value = on ? "search" : "off") }),
		research,
		/** The choice for the message going out now. Research goes off with it. */
		take(): WebChoice {
			const choice: WebChoice = research.value ? { web: "research", keep: kept.value } : { web: kept.value };
			research.value = false;
			return choice;
		},
		/** A message that did not go out, or one handed over from a workspace page: its choice is set again. */
		restore(choice: WebChoice) {
			picked.value = keptMode(choice, kept.value);
			research.value = choice.web === "research";
		},
	};
}

/** The choice the chat's last message was sent with, to start a saved chat's toggles from. */
export const savedWebChoice = (messages: UIMessage[]) => latestWebChoice(messages);

/** The choice of the message that `reply` answers, or none for a reply from before the choice existed. */
export function askedWith(messages: UIMessage[], reply: UIMessage) {
	for (let index = messages.indexOf(reply) - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return webChoiceOf(message.metadata);
	}
	return undefined;
}

/**
 * What a reply used, for the line under it. A chat outside a workspace with the web on is
 * the usual case and says nothing.
 */
export function webLabel(choice: WebChoice | undefined, inWorkspace: boolean) {
	if (!choice) return undefined;
	if (choice.web === "research") return "Deep research";
	if (inWorkspace) return choice.web === "off" ? "Sources only" : "Sources + web";
	return choice.web === "off" ? "Web search off" : undefined;
}

/** The messages with the person's latest one set to search the web once; the chat stays on `keep`. */
export function withWebOnce(messages: UIMessage[], keep: KeptWebMode): UIMessage[] {
	const at = messages.findLastIndex((message) => message.role === "user");
	const choice: WebChoice = { web: "search", keep };
	return messages.map((message, index) => (index === at ? { ...message, metadata: { ...(isRecord(message.metadata) ? message.metadata : {}), ...choice } } : message));
}

/** The tool a reply calls when the Sources do not have the answer (server/search/schema.ts). */
export const OFFER_WEB_SEARCH = "offer_web_search";

/** The reply offers a web search: it called offer_web_search. */
export function offersWebSearch(message: UIMessage) {
	return message.parts.some((part) => part.type === `tool-${OFFER_WEB_SEARCH}`);
}
