import { defineAsyncComponent } from "vue";
import { once } from "./once";
import { toastsWanted } from "./toasts";

type Parts = typeof import("./transcript");

/**
 * The transcript's chunk (transcript.ts), loaded once: by the first chat with messages, or
 * ahead of time. Some of its components show frappe-ui's toasts themselves, so the toasts'
 * host mounts with it (toasts.ts).
 */
export const loadTranscript = once(() =>
	import("./transcript").then((parts) => {
		toastsWanted.value = true;
		return parts;
	}),
);

/**
 * One of the transcript's components, which renders once its chunk is here. Typed as the
 * component itself, so templates check its props. Made once, here, not per chat: after the
 * first load, a chat that opens renders its messages at once.
 */
function part<K extends keyof Parts>(name: K): Parts[K] {
	return defineAsyncComponent(() => loadTranscript().then((parts) => parts[name])) as unknown as Parts[K];
}

export const Conversation = part("Conversation");
export const ConversationContent = part("ConversationContent");
export const ConversationItem = part("ConversationItem");
export const ConversationScrollButton = part("ConversationScrollButton");
export const Loader = part("Loader");
export const Message = part("Message");
export const MessageActions = part("MessageActions");
export const MessageContent = part("MessageContent");
export const MessageCopyAction = part("MessageCopyAction");
export const MessageParts = part("MessageParts");
export const CitationChip = part("CitationChip");
export const CiteButton = part("CiteButton");
export const CompactionDivider = part("CompactionDivider");
export const SkillChip = part("SkillChip");

/** How a reply shows its tool calls (provideToolRenderers in ChatView.vue). */
const WebToolPart = part("WebToolPart");
export const toolRenderers = {
	run_python: part("RunPythonPart"),
	web_search: WebToolPart,
	web_fetch: WebToolPart,
	use_skill: part("UseSkillPart"),
	write_artifact: part("ArtifactPart"),
};
