import type { UseChatHelpers, UseChatOptions } from "@ai-sdk/vue";
import type { ChatStatus, UIMessage } from "ai";
import { computed, getCurrentScope, shallowRef } from "vue";
import { once } from "./once";

type ChatSdk = typeof import("./chat-sdk");
type Chat = UseChatHelpers<UIMessage>;

/** The AI SDK (chat-sdk.ts), loaded once: by the first chat that needs it, or ahead of time (Workspace.vue). */
export const loadChatSdk = once(() => import("./chat-sdk"));

/**
 * useChat from @ai-sdk/vue, without the SDK in the page's first code. The chat shows its
 * messages and status at once, from `initialMessages`. The SDK loads at the first call
 * (send, stop, resume), which waits for it; the shell loads it ahead once the page is idle
 * (Workspace.vue). Call it in a component's setup: the chat stops with the component, as
 * useChat's does.
 */
export function useLazyChat(options: (sdk: ChatSdk) => UseChatOptions<UIMessage>, initialMessages: UIMessage[]) {
	const scope = getCurrentScope();
	const chat = shallowRef<Chat>();
	// The messages until the SDK is here. useChat then starts from them.
	const early = shallowRef(initialMessages);
	let ready: Promise<Chat | undefined> | undefined;

	/** The chat, made the first time it is needed. Undefined when the component closed first. */
	function start() {
		ready ??= loadChatSdk().then(
			(sdk) => {
				if (!scope?.active) return undefined;
				chat.value = scope.run(() => sdk.useChat({ ...options(sdk), messages: early.value }));
				return chat.value;
			},
			(error: unknown) => {
				// Offline, say: the next call tries again.
				ready = undefined;
				throw error;
			},
		);
		return ready;
	}

	const messages = computed<UIMessage[]>({
		get: () => (chat.value ? chat.value.messages.value : early.value),
		set: (value) => {
			if (chat.value) chat.value.messages.value = value;
			else early.value = value;
		},
	});
	return {
		messages,
		status: computed<ChatStatus>(() => chat.value?.status.value ?? "ready"),
		error: computed(() => chat.value?.error.value),
		sendMessage: async (...args: Parameters<Chat["sendMessage"]>) => (await start())?.sendMessage(...args),
		addToolApprovalResponse: async (...args: Parameters<Chat["addToolApprovalResponse"]>) => (await start())?.addToolApprovalResponse(...args),
		regenerate: async (...args: Parameters<Chat["regenerate"]>) => (await start())?.regenerate(...args),
		resumeStream: async (...args: Parameters<Chat["resumeStream"]>) => (await start())?.resumeStream(...args),
		// Nothing to stop before the chat exists.
		stop: async () => chat.value?.stop(),
	};
}
