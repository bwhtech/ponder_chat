import { inject, provide, type InjectionKey } from "vue";

/**
 * What a card's buttons do in this chat: send a message as if the person typed it. The
 * chat provides it (ToolContext.vue), so a message sent while a reply streams waits in
 * the queue like any other.
 */
export type SendFromCard = (text: string) => void;

const KEY: InjectionKey<SendFromCard> = Symbol("genui-send");

export function provideCardSend(send: SendFromCard) {
	provide(KEY, send);
}

export function useCardSend() {
	return inject(KEY, null);
}

/** Only web pages open from a card: never javascript: or data: addresses. */
export function safeUrl(url: unknown) {
	if (typeof url !== "string") return undefined;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}
