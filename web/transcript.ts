/**
 * What a chat shows only once it has messages: the replies with their Markdown, maths and
 * code (marked, KaTeX, highlight.js), the tool steps, artifacts and quotes. A new chat
 * needs none of it, so this is its own chunk (transcript-parts.ts loads it).
 */
export {
	Conversation,
	ConversationContent,
	ConversationItem,
	ConversationScrollButton,
	Loader,
	Message,
	MessageActions,
	MessageContent,
	MessageCopyAction,
	MessageParts,
} from "frappe-ui-ai-elements";
export { default as CitationChip } from "./cite/CitationChip.vue";
export { default as CiteSelection } from "./cite/CiteSelection.vue";
// Finding and marking a quote in its reply, for the chat's quote chips (ChatView.vue).
export { markQuote, revealCitation } from "./cite/highlight";
export { findSource, resolveRange } from "./cite/text";
export { default as CompactionDivider } from "./CompactionDivider.vue";
export { default as SkillChip } from "./skills/SkillChip.vue";
export { default as ToolContext } from "./ToolContext.vue";
