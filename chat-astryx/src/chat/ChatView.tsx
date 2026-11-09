import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport, type ReconnectToStreamOptions, type WorkflowChatTransportOptions } from "@ai-sdk/workflow/client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ChevronDoubleUpIcon } from "@heroicons/react/24/outline";
import { ChatLayout, ChatMessage, ChatMessageList, ChatMessageMetadata } from "@astryxdesign/core/Chat";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type ChatRequestOptions, type UIMessage, type UIMessageChunk } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { me } from "../lib/account";
import { model as lastPicked, modelName, models as modelList } from "../lib/models";
import { useStore } from "../lib/store";
import { chatBusy, chatMounted, failureOf, forgetFailure, markFailed, remember } from "../lib/threads";
import SentQuotes from "../cite/SentQuotes";
import Composer from "./Composer";
import Landing from "./Landing";
import PonderAvatar from "./PonderAvatar";
import { useComposer } from "./composer/useComposer";
import CopyButton from "./CopyButton";
import MessageParts from "./MessageParts";
import "./parts/register";
import RememberedNotes from "./parts/RememberedNotes";
import { AskedSkills, ThinkingLine } from "./parts/ReplyLines";
import { useConversation } from "./parts/useConversation";
import { useRecovery } from "./useRecovery";

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
	// On a phone the replies get the whole column: compact density and no avatar beside them.
	const narrow = useMediaQuery("(max-width: 639px)");
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

	// A reply that failed before this chat last closed (threads.ts): Retry is offered again.
	const [failure] = useState(() => failureOf(threadId));
	useEffect(() => {
		chatMounted(threadId);
	}, [threadId]);
	// The messages the run this chat follows started from: what it last sent, or, for a reply
	// still being written when the thread loaded, the thread as it loaded (the server saves
	// the thread before the run, and a chat closed mid-reply keeps only this, see below).
	// After a failure, what the failed attempt sent.
	const base = useRef(failure?.sent ?? initialMessages);
	const restoreBase = useRef(() => {});
	const transport = useMemo(
		() =>
			// Each reply is a durable workflow run on the server. When the connection drops before
			// the reply ends (a server restart, a flaky network), the transport reconnects to the
			// run and picks up where it left off. The model goes with every request.
			new ReplayTransport(() => restoreBase.current(), {
				api: "/api/chat",
				prepareSendMessagesRequest: ({ id, messages }) => {
					base.current = messages;
					return { headers: { "Content-Type": "application/json" }, body: { id, messages, model: modelRef.current } };
				},
				fetch: patientFetch,
			}),
		[],
	);

	const { messages, setMessages, sendMessage, addToolApprovalResponse, status, error, stop, resumeStream, regenerate, clearError } = useChat({
		id: threadId,
		messages: initialMessages,
		transport,
		// A connector tool on "Ask first" waits for the person; their answer goes out at once.
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
		onFinish: () => callbacks.current.onSaved(),
		onError: () => callbacks.current.onRefused(),
	});

	// The replay rebuilds the reply on the run's base, as the server does when it saves (saveReply).
	restoreBase.current = () => setMessages(base.current);

	// Following the reply again after a reload, and Retry (useRecovery.ts).
	const recovery = useRecovery({
		threadId,
		running,
		chat: { status, setMessages, sendMessage, regenerate, resumeStream, clearError },
		base,
		failure,
		onSaved: () => callbacks.current.onSaved(),
	});
	/** Stop could not reach the server: a banner offers to try again. */
	const [stopFailed, setStopFailed] = useState(false);
	// "Always allow" answers once its rule is saved; by then this chat may have closed.
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// A failure from before the chat closed counts as an error: the queue waits, Retry shows.
	const sdkStatus = recovery.failure && status === "ready" ? "error" : status;
	// While recovery waits for the server, the SDK's status still says ready, or error.
	const chatStatus = recovery.pending && (sdkStatus === "ready" || sdkStatus === "error") ? "submitted" : sdkStatus;
	const errorText = error ? errorMessage(error) : recovery.failure?.error;
	const busy = chatStatus === "submitted" || chatStatus === "streaming";
	const latest = useRef(messages);
	latest.current = messages;
	const failed = useRef<string | undefined>(undefined);
	failed.current = sdkStatus === "error" ? (errorText ?? "") : undefined;
	const wasBusy = useRef(busy);
	useEffect(() => {
		chatBusy.set(busy);
		// A reply ended: keep this chat's messages, so coming back to it is instant. After an error
		// the run may go on; the next open asks the server, which says so.
		if (wasBusy.current && !busy) {
			remember(threadId, { messages: latest.current, running: false });
			if (sdkStatus !== "error") forgetFailure(threadId);
		}
		wasBusy.current = busy;
		if (!busy) setStopFailed(false);
	}, [busy, threadId]);
	useEffect(
		() => () => {
			// Closed after an error: the run may go on, or have ended, on the server. The next open asks
			// it first, and keeps this chat's messages and Retry unless the server took the attempt.
			if (failed.current !== undefined) markFailed(threadId, { sent: base.current, messages: latest.current, error: failed.current });
			// Closed mid-reply: the next open follows the run again, and its replay rebuilds the reply on the base.
			else if (wasBusy.current) remember(threadId, { messages: base.current, running: true });
			chatBusy.set(false);
		},
		[threadId],
	);

	const outOfCredits = (person?.credits.remaining ?? 1) <= 0;

	/**
	 * The run outlives the request, so Stop tells the server, then drops the stream here.
	 * When the server could not be told, the reply goes on, the chat keeps following it, and
	 * the person can try again. True when the run stopped.
	 */
	async function stopRun() {
		// A Retry still asking the server is dropped: it must not start a reply after Stop.
		recovery.cancel();
		const response = await fetch(`/api/chat/${encodeURIComponent(threadId)}/stop`, { method: "POST" }).catch(() => undefined);
		if (!response?.ok) {
			if (mounted.current) setStopFailed(true);
			return false;
		}
		setStopFailed(false);
		await stop();
		return true;
	}

	const lastMessage = messages[messages.length - 1];
	// Paging, the "Thinking" line, memory notes under replies, and the tab badge (parts/useConversation.ts).
	const conversation = useConversation({ threadId, initialMessages, messages, busy });
	// Writing and sending: drafts, files, skills, quotes and the queue (composer/useComposer.ts).
	const area = useRef<HTMLDivElement>(null);
	const showEarlier = () => conversation.hidden > 0 && (conversation.showEarlier(), true);
	const composer = useComposer({
		threadId,
		area,
		messages,
		setMessages,
		sendMessage,
		status: chatStatus,
		stopRun,
		outOfCredits,
		showEarlier,
	});

	const field = (
		<Composer
			composer={composer}
			onStop={() => composer.queue.stop()}
			model={threadModel}
			onModelChange={pickModel}
			isEmpty={false}
			outOfCredits={outOfCredits}
		/>
	);

	// A new chat: the message field sits in the middle of the page, with ideas under it.
	if (messages.length === 0)
		return (
			<div ref={area} className="flex min-h-0 flex-1 flex-col" data-slot="chat-view">
				<Landing
					composer={field}
					onIdea={(prompt) => {
						composer.setInput(prompt);
						// The field gets focus with the caret after the prompt, so typing finishes it.
						requestAnimationFrame(() => focusAtEnd(area.current?.querySelector<HTMLElement>('[contenteditable="true"], textarea')));
					}}
				/>
			</div>
		);

	return (
		<div ref={area} className="flex min-h-0 flex-1 flex-col" data-slot="chat-view">
			<ChatLayout
				composer={field}
				density={narrow ? "compact" : "balanced"}
			>
				{messages.length > 0 && (
					<ChatMessageList isStreaming={busy} density={narrow ? "compact" : "balanced"} className="mx-auto w-full max-w-[760px]">
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
									avatar={message.role === "assistant" && !narrow ? <PonderAvatar /> : null}
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
											onApproval={(id, approved) => mounted.current && void addToolApprovalResponse({ id, approved, reason: approved ? undefined : "The person denied this." })}
										/>
									</div>
									{conversation.thinkingAfter(message) && <ThinkingLine text={conversation.thinkingText} />}
									<RememberedNotes notes={conversation.notes.byMessage.get(message.id) ?? []} fresh={conversation.notes.fresh} onUndo={conversation.notes.undo} />
								</ChatMessage>
							);
						})}
						{conversation.thinkingAlone && (
							<ChatMessage sender="assistant" avatar={narrow ? null : <PonderAvatar />}>
								<ThinkingLine text={conversation.thinkingText} />
							</ChatMessage>
						)}
						{stopFailed && busy && (
							<Banner
								status="error"
								title="Ponder could not stop the reply"
								description="The reply goes on. Try again."
								endContent={<Button label="Stop" variant="secondary" size="sm" onClick={() => composer.queue.stop()} />}
								data-slot="stop-error"
							/>
						)}
						{/* Out of credits, the notice under the field says why and when they refill. */}
						{errorText !== undefined && !busy && !outOfCredits && (
							<Banner
								status="error"
								title="Something went wrong"
								description={errorText || "Something went wrong. Try again."}
								endContent={<Button label="Retry" variant="secondary" size="sm" onClick={() => void recovery.retry()} />}
								data-slot="chat-error"
							/>
						)}
					</ChatMessageList>
				)}
			</ChatLayout>
		</div>
	);
}

function focusAtEnd(field: HTMLElement | null | undefined) {
	if (!field) return;
	field.focus();
	if (field instanceof HTMLTextAreaElement) return field.setSelectionRange(field.value.length, field.value.length);
	const range = document.createRange();
	range.selectNodeContents(field);
	range.collapse(false);
	const selection = getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
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
			if (init?.signal?.aborted) throw error;
			// Not a TypeError: the SDK would keep the half-built reply for the next reconnect, and the replay would add to it.
			if (Date.now() > deadline) throw new Error("Ponder Chat could not reach the server.", { cause: error });
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 3_000)));
	}
}

/**
 * The workflow transport, for a reconnect (a reload, or Retry). The server replays the run
 * from its first chunk, so once the replay starts `onReplay` puts the messages back to the
 * run's base, and the replay builds the reply again instead of adding to what is on screen.
 * The SDK reads the messages after this returns, so the replay is waited for first.
 */
class ReplayTransport extends WorkflowChatTransport<UIMessage> {
	constructor(
		private onReplay: () => void,
		options: WorkflowChatTransportOptions<UIMessage>,
	) {
		super(options);
	}

	override async reconnectToStream(options: ReconnectToStreamOptions & ChatRequestOptions) {
		const stream = await super.reconnectToStream(options);
		if (!stream) return stream;
		const reader = stream.getReader();
		const first = await reader.read();
		this.onReplay();
		return new ReadableStream<UIMessageChunk>({
			start(controller) {
				if (first.done) controller.close();
				else controller.enqueue(first.value);
			},
			async pull(controller) {
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			cancel: (reason) => reader.cancel(reason),
		});
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
