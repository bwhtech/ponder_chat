<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { FileUIPart, UIMessage } from "ai";
import { Alert, Button } from "frappe-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { me } from "./account";
import { useAttention } from "./attention";
import { useDraft } from "./drafts";
import { canUndo, fetchThreadSaves, undoSave, type MemoryOperation, type MemorySave } from "./memory";
import { closeOpenCalls, queueFor, waitingOnPerson, type Queued } from "./message-queue";
import { features, model, modelName, models } from "./models";
import RunPythonPart from "./RunPythonPart.vue";
import WebToolPart from "./WebToolPart.vue";
import { useThreads } from "./threads";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationItem,
	ConversationScrollButton,
	Loader,
	Message,
	MessageActions,
	MessageContent,
	MessageCopyAction,
	MessageParts,
	ModelSelector,
	PromptInput,
	PromptInputAttachButton,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputQueue,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	provideToolRenderers,
	Suggestion,
	Suggestions,
} from "./ai-elements";

/** One chat: the conversation and the message field. The shell mounts a new one per thread. */
const props = defineProps<{ threadId: string; initialMessages: UIMessage[]; running?: boolean }>();
const emit = defineEmits<{
	/** A reply finished and the thread was saved: its place in the list and the credits left changed. */
	saved: [];
	/** A request failed, perhaps for want of credits: the shell asks how many are left. */
	refused: [];
	/** The person wants to see or change what Ponder remembers. */
	openMemory: [];
}>();

const { messages, sendMessage, status, error, stop, regenerate, resumeStream } = useChat({
	id: props.threadId,
	messages: props.initialMessages,
	// Each reply is a durable workflow run on the server. When the connection drops before
	// the reply ends (a server restart, a flaky network), the transport reconnects to the
	// run and picks up where it left off. The model goes with every request.
	transport: new WorkflowChatTransport({
		api: "/api/chat",
		prepareSendMessagesRequest: ({ id, messages }) => ({
			headers: { "Content-Type": "application/json" },
			body: { id, messages, model: model.value },
		}),
		fetch: patientFetch,
	}),
	onFinish: () => {
		emit("saved");
		void loadRemembered({ wait: true });
	},
	onError: () => emit("refused"),
});

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

// What each reply added to memory, by message id, one entry per save so each can be undone.
// Memory saves after the reply, so the page asks again once a reply finishes, and the server waits for the save.
type Remembered = { save: MemorySave; operations: MemoryOperation[] };
const remembered = ref(new Map<string, Remembered[]>());
const MEMORY_LABELS = { add: "Remembered", update: "Updated memory", forget: "Forgot" } as const;
// Saves that arrived after the first load (a reply just finished): only these animate in.
const newSaves = ref(new Set<number>());
const shownSaves = new Set<number>();
let loadedSaves = false;

async function loadRemembered({ wait = false } = {}) {
	const saves = await fetchThreadSaves(props.threadId, { wait });
	const byMessage = new Map<string, Remembered[]>();
	for (const save of [...saves].reverse()) {
		if (!save.messageId) continue;
		const operations = save.operations.filter((op) => op.status === "applied");
		if (operations.length) byMessage.set(save.messageId, [...(byMessage.get(save.messageId) ?? []), { save, operations }]);
	}
	const ids = [...byMessage.values()].flat().map(({ save }) => save.id);
	newSaves.value = new Set(loadedSaves ? ids.filter((id) => !shownSaves.has(id)) : []);
	for (const id of ids) shownSaves.add(id);
	loadedSaves = true;
	remembered.value = byMessage;
}

async function undoRemembered(save: MemorySave) {
	try {
		await undoSave(save.id);
	} finally {
		await loadRemembered();
	}
}

onMounted(() => {
	void loadRemembered();
	// The reply was still being written when the thread loaded (after a reload, say): follow it.
	if (props.running) void resumeStream();
});

const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);
const refillTime = computed(() =>
	me.value ? new Date(me.value.credits.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "",
);

const input = ref("");
// What the person was writing in this chat comes back after a switch or a reload.
useDraft(props.threadId, input);
const uploading = ref(false);
const uploadError = ref("");
// What the server can pass to the model; spreadsheets only when Python can read them.
const ACCEPT = computed(() => `image/png,image/jpeg,image/webp,image/gif,application/pdf,.csv,.tsv,.txt,.md,.json${features.value.python ? ",.xlsx,.xls,.ods" : ""}`);
// A Python run shows its code, what it printed, and the files it made.
provideToolRenderers({ run_python: RunPythonPart, web_search: WebToolPart, web_fetch: WebToolPart });
const suggestions = computed(() => [
	"Explain a concept like I'm new to it",
	"Help me write a polite follow-up email",
	features.value.python ? "Chart compound interest on ₹10,000 at 8% for 20 years" : "Plan a 3-day trip on a small budget",
]);

// A long thread shows its latest messages first; older ones render only when asked for.
// The start always falls on the person's message, so no turn is cut.
const PAGE = 12;
const firstShown = ref(turnStart(props.initialMessages, props.initialMessages.length - PAGE));
const shownMessages = computed(() => messages.value.slice(firstShown.value));

function showEarlier() {
	firstShown.value = turnStart(messages.value, firstShown.value - PAGE);
}

/** The index of the person's message that starts the turn holding `index`; 0 at the top. */
function turnStart(list: UIMessage[], index: number) {
	let start = Math.max(0, index);
	while (start > 0 && list[start]?.role !== "user") start--;
	return start;
}

const busy = computed(() => status.value === "submitted" || status.value === "streaming");
const lastMessage = computed(() => messages.value[messages.value.length - 1]);
// The copy of the thread on this device follows the chat: written when a reply ends, or when
// the chat closes mid-reply (it reconnects on the way back).
const { chatBusy, remember } = useThreads();
watch(
	busy,
	(now, before) => {
		chatBusy.value = now;
		if (before && !now) remember(props.threadId, { messages: messages.value, running: false });
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (busy.value) remember(props.threadId, { messages: messages.value, running: true });
	chatBusy.value = false;
});
// While the tab is hidden, a finished reply puts a count on the favicon.
useAttention(busy, computed(() => waitingOnPerson(messages.value)));
const waitingForReply = computed(() => status.value === "submitted" && lastMessage.value?.role === "user");

// Messages written while a reply streams wait here; the first goes out when it ends.
const queue = queueFor(props.threadId);
// After Stop the queue waits, so it does not send what the person may no longer want; sending or Steer resumes it.
const queuePaused = ref(false);
const queueItems = computed(() => queue.map((item) => ({ id: item.id, text: item.text, files: item.files.length })));

/** While a reply streams, the message is queued; otherwise it goes out now. */
async function send(text: string, files: File[] = []) {
	if ((!text.trim() && !files.length) || uploading.value || outOfCredits.value) {
		if (outOfCredits.value && !input.value) input.value = text;
		return;
	}
	const attached = await upload(files);
	// The field cleared on submit; give the text back so only the files need attaching again.
	if (!attached) {
		if (!input.value) input.value = text;
		return;
	}
	const item = { id: crypto.randomUUID(), text, files: attached };
	if (busy.value) queue.push(item);
	else await sendNow(item);
}

async function sendNow({ text, files }: Pick<Queued, "text" | "files">) {
	queuePaused.value = false;
	const closed = closeOpenCalls(messages.value);
	if (closed) messages.value = closed;
	sendMessage(files.length ? { text, files } : { text });
}

function takeFromQueue(id: string) {
	const index = queue.findIndex((item) => item.id === id);
	return index === -1 ? undefined : queue.splice(index, 1)[0];
}

/** Steer: stop the reply on its way and send this message now. */
async function steer(id: string) {
	const item = takeFromQueue(id);
	if (!item) return;
	if (busy.value) await stopRun();
	await sendNow(item);
}

function stopReply() {
	if (queue.length) queuePaused.value = true;
	void stopRun();
}

/** The run outlives the request, so Stop tells the server, then drops the stream here. */
async function stopRun() {
	await fetch(`/api/chat/${encodeURIComponent(props.threadId)}/stop`, { method: "POST" }).catch(() => undefined);
	await stop();
}

function updateQueued(id: string, text: string) {
	const item = queue.find((queued) => queued.id === id);
	if (item) item.text = text;
}

function reorderQueue(ids: string[]) {
	const byId = new Map(queue.map((item) => [item.id, item]));
	queue.splice(0, queue.length, ...ids.map((id) => byId.get(id)!).filter(Boolean));
}

// Send the next queued message once the reply ends. Not after an error or Stop, and not without credits.
watch(
	() => [status.value, queue.length] as const,
	([current, queued]) => {
		if (current !== "ready" || !queued) return;
		setTimeout(() => {
			if (status.value !== "ready" || !queue.length || queuePaused.value || outOfCredits.value) return;
			void sendNow(queue.shift()!);
		});
	},
	{ immediate: true },
);

/** Uploads the attached files; the message carries links to them. Returns null if any failed. */
async function upload(files: File[]): Promise<FileUIPart[] | null> {
	uploadError.value = "";
	if (!files.length) return [];
	uploading.value = true;
	try {
		return await Promise.all(
			files.map(async (file) => {
				const body = new FormData();
				body.append("file", file);
				const response = await fetch("/api/files", { method: "POST", body });
				const result = await response.json().catch(() => ({ error: `"${file.name}" could not be uploaded.` }));
				if (!response.ok) throw new Error(result.error ?? `"${file.name}" could not be uploaded.`);
				return { type: "file" as const, mediaType: result.mediaType, filename: result.name, url: result.url };
			}),
		);
	} catch (error) {
		uploadError.value = error instanceof Error ? error.message : String(error);
		return null;
	} finally {
		uploading.value = false;
	}
}

function isStreaming(message: UIMessage) {
	return busy.value && message === lastMessage.value;
}

function replyText(message: UIMessage) {
	return message.parts.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n\n");
}

/** The model that wrote a reply, from the metadata the server attaches. */
function replyModel(message: UIMessage) {
	const id = (message.metadata as { model?: string } | undefined)?.model;
	return id ? (modelName(id) ?? id) : undefined;
}
</script>

<template>
	<div class="relative min-h-0 flex-1">
		<ConversationEmptyState
			v-if="messages.length === 0"
			icon="lucide-message-circle"
			title="What's on your mind?"
			description="Ask anything. Pick a model below; bigger models use more of your daily credits."
		/>
		<Conversation v-else>
			<ConversationContent class="mx-auto w-full max-w-[770px] px-3 pb-6 pt-6 sm:px-5">
				<ConversationItem v-if="firstShown > 0" class="flex justify-center pb-4">
					<Button variant="ghost" size="sm" icon-left="lucide-chevrons-up" @click="showEarlier">
						Show earlier messages ({{ firstShown }})
					</Button>
				</ConversationItem>
				<ConversationItem
					v-for="message in shownMessages"
					:key="message.id"
					:message-id="message.id"
					:scroll-anchor="message.role === 'user'"
				>
					<Message :from="message.role">
						<MessageContent>
							<MessageParts :message="message" :streaming="isStreaming(message)" />
							<MessageActions v-if="message.role === 'assistant' && !isStreaming(message) && replyText(message)">
								<MessageCopyAction :value="replyText(message)" />
								<span v-if="replyModel(message)" class="px-1 text-p-xs text-ink-gray-5" data-slot="reply-model">{{ replyModel(message) }}</span>
							</MessageActions>
							<div
								v-for="{ save, operations } in remembered.get(message.id) ?? []"
								:key="save.id"
								data-slot="memory-saved"
								:data-new="newSaves.has(save.id) || undefined"
								class="flex flex-wrap items-start gap-x-1"
							>
								<div class="min-w-0">
									<button
										v-for="op in operations"
										:key="op.memoryId + op.op"
										type="button"
										data-slot="memory-note"
										class="flex w-fit max-w-full items-start gap-1.5 rounded-4 px-1 py-0.5 text-left text-p-sm text-ink-gray-5 hover:bg-surface-gray-2 hover:text-ink-gray-7 active:bg-surface-gray-3"
										:class="{ 'line-through': save.undoneAt }"
										title="Open Memory"
										@click="emit('openMemory')"
									>
										<span class="lucide-brain mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
										<span class="min-w-0"><span class="text-ink-gray-7">{{ MEMORY_LABELS[op.op] }}:</span> {{ op.op === "forget" ? op.note : op.text }}</span>
									</button>
								</div>
								<button
									v-if="canUndo(save)"
									type="button"
									data-slot="memory-undo"
									class="rounded-4 px-1 py-0.5 text-p-sm text-ink-gray-5 underline hover:bg-surface-gray-2 hover:text-ink-gray-8 active:bg-surface-gray-3"
									@click="undoRemembered(save)"
								>
									Undo
								</button>
								<span v-else-if="save.undoneAt" class="px-1 py-0.5 text-p-sm text-ink-gray-4">Undone</span>
							</div>
						</MessageContent>
					</Message>
				</ConversationItem>
				<ConversationItem v-if="waitingForReply">
					<Loader text="Thinking…" />
				</ConversationItem>
				<ConversationItem v-if="error && !outOfCredits">
					<Alert
						theme="red"
						title="Something went wrong"
						:description="error.message"
						:primary-action="{ label: 'Retry', onClick: () => regenerate() }"
					/>
				</ConversationItem>
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	</div>

	<footer class="mx-auto w-full max-w-[770px] shrink-0 space-y-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
		<Suggestions v-if="messages.length === 0 && !outOfCredits">
			<Suggestion v-for="suggestion in suggestions" :key="suggestion" :suggestion="suggestion" @select="send" />
		</Suggestions>
		<Alert
			v-if="outOfCredits"
			theme="amber"
			title="You've used today's credits"
			:description="`They refill at ${refillTime}. Your chats are saved, and you can keep reading them.`"
			data-slot="out-of-credits"
		/>
		<Alert v-if="uploadError" theme="red" :title="uploadError" description="Attach the files again to send them." />
		<div>
			<PromptInputQueue :items="queueItems" @steer="steer" @remove="takeFromQueue" @update="updateQueued" @reorder="reorderQueue" />
			<PromptInput
				v-model="input"
				queue
				:status="status"
				:disabled="uploading || outOfCredits"
				:accept="ACCEPT"
				@submit="send($event.text, $event.files)"
				@stop="stopReply"
			>
				<PromptInputHeader />
				<PromptInputTextarea placeholder="Message Ponder Chat" autofocus />
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputAttachButton />
						<ModelSelector v-if="models.length" v-model="model" :models="models" label="Model" />
						<span v-if="uploading" class="px-1.5 text-xs text-ink-gray-4">Uploading…</span>
					</PromptInputTools>
					<PromptInputSubmit />
				</PromptInputFooter>
			</PromptInput>
		</div>
	</footer>
</template>
