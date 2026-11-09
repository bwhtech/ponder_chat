import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ChevronDoubleUpIcon } from "@heroicons/react/24/outline";
import { ChatLayout, ChatMessage, ChatMessageList, ChatMessageMetadata } from "@astryxdesign/core/Chat";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { me } from "../lib/account";
import { model as lastPicked, modelName, models as modelList } from "../lib/models";
import { useStore } from "../lib/store";
import { chatBusy, remember } from "../lib/threads";
import SentQuotes from "../cite/SentQuotes";
import Composer from "./Composer";
import { useComposer } from "./composer/useComposer";
import CopyButton from "./CopyButton";
import MessageParts from "./MessageParts";
import "./parts/register";
import RememberedNotes from "./parts/RememberedNotes";
import { AskedSkills, ThinkingLine } from "./parts/ReplyLines";
import { useConversation } from "./parts/useConversation";

/** One chat: the conversation and the message field. The shell mounts a new one per thread. */
export type ChatViewProps = {
	threadId: string;
	initialMessages: UIMessage[];
	/** The reply was still being written when the thread loaded: follow it. */
	running: boolean;
	/** A reply finished and the thread was saved: its place in the list and the credits left changed. */
	onSaved: () => void;
	/** A request failed, perhaps for want of credits: the shell asks how many are left. */
	onRefused: () => void;
};

export default function ChatView({ threadId, initialMessages, running, onSaved, onRefused }: ChatViewProps) {
	const person = useStore(me);
	const models = useStore(modelList);
	// The model for this chat: the one that wrote its last reply, so going back to a chat
	// brings back its model. A new chat starts on the model picked last, and a pick here
	// becomes the one new chats start on.
	const [threadModel, setThreadModel] = useState(() => lastReplyModel(initialMessages) ?? lastPicked.get());
	const modelRef = useRef(threadModel);
	modelRef.current = threadModel;
	useEffect(() => {
		// A model that left the list falls back to the one picked last.
		if (models.length && !models.some((option) => option.id === threadModel)) setThreadModel(lastPicked.get());
	}, [models, threadModel]);

	function pickModel(id: string) {
		setThreadModel(id);
		lastPicked.set(id);
	}

	const callbacks = useRef({ onSaved, onRefused });
	callbacks.current = { onSaved, onRefused };

	const transport = useMemo(
		() =>
			// Each reply is a durable workflow run on the server. When the connection drops before
			// the reply ends (a server restart, a flaky network), the transport reconnects to the
			// run and picks up where it left off. The model goes with every request.
			new WorkflowChatTransport({
				api: "/api/chat",
				prepareSendMessagesRequest: ({ id, messages }) => ({
					headers: { "Content-Type": "application/json" },
					body: { id, messages, model: modelRef.current },
				}),
				fetch: patientFetch,
			}),
		[],
	);

	const { messages, setMessages, sendMessage, addToolApprovalResponse, status, error, stop, resumeStream } = useChat({
		id: threadId,
		messages: initialMessages,
		transport,
		// A connector tool on "Ask first" waits for the person; their answer goes out at once.
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
		onFinish: () => callbacks.current.onSaved(),
		onError: () => callbacks.current.onRefused(),
	});

	// The reply was still being written when the thread loaded (after a reload, say): follow it.
	useEffect(() => {
		if (running) void resumeStream();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const busy = status === "submitted" || status === "streaming";
	const latest = useRef(messages);
	latest.current = messages;
	const wasBusy = useRef(busy);
	useEffect(() => {
		chatBusy.set(busy);
		// A reply ended: keep this chat's messages, so coming back to it is instant.
		if (wasBusy.current && !busy) remember(threadId, { messages: latest.current, running: false });
		wasBusy.current = busy;
	}, [busy, threadId]);
	useEffect(
		() => () => {
			if (wasBusy.current) remember(threadId, { messages: latest.current, running: true });
			chatBusy.set(false);
		},
		[threadId],
	);

	const outOfCredits = (person?.credits.remaining ?? 1) <= 0;

	/** The run outlives the request, so Stop tells the server, then drops the stream here. */
	async function stopRun() {
		await fetch(`/api/chat/${encodeURIComponent(threadId)}/stop`, { method: "POST" }).catch(() => undefined);
		await stop();
	}

	const lastMessage = messages[messages.length - 1];
	// Paging, the "Thinking" line, memory notes under replies, and the tab badge (parts/useConversation.ts).
	const conversation = useConversation({ threadId, initialMessages, messages, busy });
	// Writing and sending: drafts, files, skills, quotes and the queue (composer/useComposer.ts).
	const area = useRef<HTMLDivElement>(null);
	const showEarlier = () => conversation.hidden > 0 && (conversation.showEarlier(), true);
	const composer = useComposer({ threadId, area, messages, setMessages, sendMessage, status, stopRun, outOfCredits, showEarlier });

	return (
		<div ref={area} className="flex min-h-0 flex-1 flex-col" data-slot="chat-view">
			<ChatLayout
				emptyState={<Landing />}
				composer={
					<Composer
						composer={composer}
						onStop={() => composer.queue.stop()}
						model={threadModel}
						onModelChange={pickModel}
						isEmpty={messages.length === 0}
						outOfCredits={outOfCredits}
						status={error && !busy ? { type: "error", message: errorMessage(error) } : undefined}
					/>
				}
			>
				{messages.length > 0 && (
					<ChatMessageList isStreaming={busy} className="mx-auto w-full max-w-[760px]">
						{conversation.hidden > 0 && (
							<div className="flex justify-center pb-4" data-slot="show-earlier">
								<Button label={`Show earlier messages (${conversation.hidden})`} variant="ghost" size="sm" icon={<Icon icon={ChevronDoubleUpIcon} />} onClick={conversation.showEarlier} />
							</div>
						)}
						{conversation.shown.map((message) => {
							const streaming = busy && message === lastMessage;
							const text = replyText(message);
							return (
								<ChatMessage
									key={message.id}
									sender={message.role === "user" ? "user" : "assistant"}
									metadata={
										message.role === "assistant" && !streaming && text ? (
											<ChatMessageMetadata
												footer={
													<HStack gap={1} vAlign="center">
														<CopyButton value={text} />
														{replyModel(message) && (
															<Text type="supporting" color="secondary" data-slot="reply-model">
																{replyModel(message)}
															</Text>
														)}
													</HStack>
												}
											/>
										) : undefined
									}
								>
									<AskedSkills names={conversation.askedSkills(message)} />
									<SentQuotes message={message} onReveal={composer.cites.reveal} />
									{/* The text a person can quote with Cite: a finished reply's parts (cite/selection.ts). */}
									<div className="contents" data-cite-source={message.role === "assistant" && !streaming ? message.id : undefined}>
										<MessageParts
											message={message}
											streaming={streaming}
											onApproval={(id, approved) => addToolApprovalResponse({ id, approved, reason: approved ? undefined : "The person denied this." })}
										/>
									</div>
									{conversation.thinkingAfter(message) && <ThinkingLine text={conversation.thinkingText} />}
									<RememberedNotes notes={conversation.notes.byMessage.get(message.id) ?? []} fresh={conversation.notes.fresh} onUndo={conversation.notes.undo} />
								</ChatMessage>
							);
						})}
						{conversation.thinkingAlone && (
							<ChatMessage sender="assistant">
								<ThinkingLine text={conversation.thinkingText} />
							</ChatMessage>
						)}
					</ChatMessageList>
				)}
			</ChatLayout>
		</div>
	);
}

function Landing() {
	return (
		<VStack gap={4} hAlign="center" className="px-4 text-center" data-slot="landing">
			<img src="/logo.png" alt="" className="size-11" />
			<VStack gap={2} hAlign="center">
				<Heading level={2}>What's on your mind?</Heading>
				<Text color="secondary" className="max-w-sm text-balance">
					Ask anything. Pick a model below; bigger models use more of your daily credits.
				</Text>
			</VStack>
		</VStack>
	);
}

/**
 * fetch for the transport: reconnecting to a reply (a GET) waits and tries again for up
 * to 30 seconds while the server is unreachable or restarting (502, 503, 504 from the
 * proxy). Sending a message (a POST) is never repeated, so it cannot start a reply twice.
 */
async function patientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if ((init?.method ?? "GET") !== "GET") return fetch(input, init);
	const deadline = Date.now() + 30_000;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(input, init);
			if (![502, 503, 504].includes(response.status) || Date.now() > deadline) return response;
		} catch (error) {
			if (init?.signal?.aborted || Date.now() > deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 3_000)));
	}
}

/** The server's own words when it sent some ({ error }), else the SDK's. */
function errorMessage(error: Error) {
	try {
		const body = JSON.parse(error.message) as { error?: string };
		if (body.error) return body.error;
	} catch {
		// Not JSON: the message as it is.
	}
	return error.message || "Something went wrong. Try again.";
}

function replyText(message: UIMessage) {
	return message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n\n");
}

function replyModelId(message: UIMessage) {
	return (message.metadata as { model?: string } | undefined)?.model;
}

/** The model that wrote a reply, from the metadata the server attaches. */
function replyModel(message: UIMessage) {
	const id = replyModelId(message);
	return id ? (modelName(id) ?? id) : undefined;
}

function lastReplyModel(messages: UIMessage[]) {
	const reply = messages.findLast((message) => message.role === "assistant" && replyModelId(message));
	return reply && replyModelId(reply);
}
