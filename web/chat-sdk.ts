/**
 * The AI SDK's chat, which sends messages and streams replies. It brings zod with it, so it
 * is its own chunk, loaded by lazy-chat.ts: the page draws without it.
 */
export { useChat } from "@ai-sdk/vue";
export { WorkflowChatTransport } from "@ai-sdk/workflow/client";
export { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
