<script setup lang="ts">
import { useChat } from "@ai-sdk/vue";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { lastAssistantMessageIsCompleteWithApprovalResponses, type FileUIPart, type UIMessage } from "ai";
import { Alert, Button, toast } from "frappe-ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { me } from "./account";
import { useAttention } from "./attention";
import { askForMoreCredits, outOfCreditsNotice } from "./credit-request";
import { changeConnector, connectors, findTool, loadConnectors, toolTitle } from "./connectors/api";
import { useDraft } from "./drafts";
import { canUndo } from "./memory";
import { MEMORY_LABELS, useRememberedNotes } from "./remembered-notes";
import { useThinking } from "./thinking";
import { closeOpenCalls, useMessageQueue, waitingOnPerson, type Queued } from "./message-queue";
import { features, model, modelName, models } from "./models";
import { chosenCitations, citationLabel, citationPart, findSource, resolveRange, withComment, type Citation } from "./cite/citations";
import CitationChip, { type CiteAnchor } from "./cite/CitationChip.vue";
import CiteButton from "./cite/CiteButton.vue";
import { markQuote, revealCitation } from "./cite/highlight";
import { useCiteSelection } from "./cite/selection";
import RunPythonPart from "./RunPythonPart.vue";
import { useSkillPicker } from "./skills/picker";
import SkillChip from "./skills/SkillChip.vue";
import SkillMenu from "./skills/SkillMenu.vue";
import { chosenSkills, loadSkills, skillPart, skills, skillTitle } from "./skills/skills";
import UseSkillPart from "./skills/UseSkillPart.vue";
import WebToolPart from "./WebToolPart.vue";
import { useThreads } from "./threads";
import { clockTime } from "./dates";
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
	provideToolLabels,
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

// The model for this chat: the one that wrote its last reply, so going back to a chat
// brings back its model. A new chat starts on the model picked last (models.ts), and a
// pick here becomes the one new chats start on.
const threadModel = ref(lastReplyModel(props.initialMessages) ?? model.value);
watch(threadModel, (id) => id && (model.value = id));
// A model that left the list falls back to the one picked last.
watch(
	models,
	(options) => {
		if (options.length && !options.some((option) => option.id === threadModel.value)) threadModel.value = model.value;
	},
	{ immediate: true },
);

function lastReplyModel(messages: UIMessage[]) {
	const reply = messages.findLast((message) => message.role === "assistant" && replyModelId(message));
	return reply && replyModelId(reply);
}

const { messages, sendMessage, addToolApprovalResponse, status, error, stop, regenerate, resumeStream } = useChat({
	id: props.threadId,
	messages: props.initialMessages,
	// Each reply is a durable workflow run on the server. When the connection drops before
	// the reply ends (a server restart, a flaky network), the transport reconnects to the
	// run and picks up where it left off. The model goes with every request.
	transport: new WorkflowChatTransport({
		api: "/api/chat",
		prepareSendMessagesRequest: ({ id, messages }) => ({
			headers: { "Content-Type": "application/json" },
			body: { id, messages, model: threadModel.value },
		}),
		fetch: patientFetch,
	}),
	// A connector tool on "Ask first" waits for the person; their answer goes out at once.
	sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
	onFinish: () => {
		emit("saved");
		void notes.load({ wait: true });
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

const notes = useRememberedNotes(props.threadId);
const { byMessage: remembered, fresh: newSaves, undo: undoRemembered } = notes;

onMounted(() => {
	void notes.load();
	// The reply was still being written when the thread loaded (after a reload, say): follow it.
	if (props.running) void resumeStream();
});

const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);
const refillTime = computed(() =>
	me.value ? clockTime(me.value.credits.resetsAt) : "",
);
// While a request for more credits waits, the notice says so and has no button.
const creditNotice = computed(() => outOfCreditsNotice(me.value?.credits, refillTime.value));

const input = ref("");
// What the person was writing in this chat comes back after a switch or a reload.
useDraft(props.threadId, input);
const uploading = ref(false);
const uploadError = ref("");
// What the server can pass to the model; spreadsheets only when Python can read them.
const ACCEPT = computed(() => `image/png,image/jpeg,image/webp,image/gif,application/pdf,.csv,.tsv,.txt,.md,.json${features.value.python ? ",.xlsx,.xls,.ods" : ""}`);
// A Python run shows its code, what it printed, and the files it made.
// Searches and page reads are one line each, so they fold with the steps around them.
// A skill Ponder chose (use_skill) stays a line of its own, so the person sees which skill shaped the reply.
provideToolRenderers(
	{ run_python: RunPythonPart, web_search: WebToolPart, web_fetch: WebToolPart, use_skill: UseSkillPart },
	{ foldable: ["web_search", "web_fetch"] },
);

// Skills: $name in the message box opens the menu (skills/picker.ts); a chosen skill is a chip until the message goes out.
const composer = ref<HTMLElement | null>(null);
const {
	chosen: skillChips,
	typed: skillQuery,
	matches: skillMatches,
	open: skillMenuOpen,
	active: skillActive,
	choose: chooseSkill,
	remove: removeSkill,
	take: takeSkills,
	listeners: skillListeners,
} = useSkillPicker(input, composer);
void loadSkills();
const placeholder = computed(() => (skills.value.length ? "Message Ponder Chat. Type $ for skills" : "Message Ponder Chat"));

/** The skills the person asked for in the message this reply answers, for the line above the reply. */
function askedSkills(message: UIMessage) {
	if (message.role !== "assistant") return [];
	return chosenSkills(messages.value[messages.value.indexOf(message) - 1]);
}

// Connector tools (Settings, Connectors) show as "Linear · Create issue". When one waits
// for approval, "Always allow" saves its rule, then approves.
if (!connectors.value) void loadConnectors().catch(() => undefined);
provideToolLabels((name) => {
	const found = findTool(name);
	if (!found) return undefined;
	const { connector, tool } = found;
	return {
		title: `${connector.name} · ${toolTitle(tool)}`,
		question: `Allow Ponder to use ${connector.name}: ${toolTitle(tool)}?`,
		alwaysAllow: async () => {
			await changeConnector(connector.id, { rules: { [tool.name]: "allow" } });
			toast.success(`Ponder now uses ${toolTitle(tool)} in ${connector.name} without asking. You can change this in Settings, Connectors.`);
		},
	};
});

/** The person answered a tool that waited for approval. The answer goes out by itself (sendAutomaticallyWhen). */
function answerApproval(id: string, approved: boolean) {
	addToolApprovalResponse({ id, approved, reason: approved ? undefined : "The person denied this." });
}
const suggestions = computed(() => [
	"Explain a concept like I'm new to it",
	"Help me write a polite follow-up email",
	features.value.python ? "Chart compound interest over 20 years" : "Plan a 3-day trip on a small budget",
]);

// A long thread shows its latest messages first; older ones render only when asked for.
// The start always falls on the person's message, so no turn is cut.
const PAGE = 12;
/** The newest reply keeps its copy button in view; older ones show it on hover. The model name always shows. */
const lastReplyId = computed(() => messages.value.findLast((message) => message.role === "assistant")?.id);
/** Messages on screen when the thread opened: they do not animate in; later ones rise in (style.css). */
const shownAtStart = new Set(props.initialMessages.map((message) => message.id));
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

// A new chat opens with the field in the middle of the page, under the greeting (on phones it
// stays at the bottom, by the thumb and the keyboard). The first message sends it down.
const landing = computed(() => messages.value.length === 0);
const area = ref<HTMLElement | null>(null);
const footer = ref<HTMLElement | null>(null);
let footerTop = 0;
// Before the page re-renders: where the field is now.
watch(landing, () => (footerTop = footer.value?.getBoundingClientRect().top ?? 0), { flush: "pre" });
watch(landing, (now) => !now && settleFooter(), { flush: "post" });

/** The field moves from where it was to its place at the bottom. The first message shows at once, like every message you send. */
function settleFooter() {
	const field = footer.value;
	if (!field) return;
	const shift = footerTop - field.getBoundingClientRect().top;
	if (Math.abs(shift) <= 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out-strong").trim() || "ease-out";
	field.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], { duration: 300, easing });
}

/** The greeting fades out where it stood, out of the layout, so it does not hold the field up. */
function pinInPlace(element: Element) {
	const el = element as HTMLElement;
	const { top, left, width, height } = el.getBoundingClientRect();
	Object.assign(el.style, { position: "fixed", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
}

// Citations: selecting text in a reply shows a Cite button (cite/selection.ts). Cite puts the
// quote in the message box as a chip and opens a field for an optional comment, beside the
// quoted text, which stays marked while the comment is written. Adapted from T3 Code.
const promptInput = ref<{ submit: () => void } | null>(null);
const citeChips = ref<Citation[]>([]);
const { pending: pendingCite, dismiss: dismissCite } = useCiteSelection(area);
/** The chip whose comment is open, and what its editor sits against: the quote, or the chip. */
const editingCite = ref<number | null>(null);
const citeAnchor = ref<CiteAnchor | null>(null);
let unmarkQuote = () => {};
onBeforeUnmount(() => unmarkQuote());

function cite() {
	const shown = pendingCite.value;
	if (!shown || shown.tooLong) return;
	document.getSelection()?.removeAllRanges();
	dismissCite();
	citeChips.value = [...citeChips.value, shown.citation];
	editComment(citeChips.value.length - 1, shown.range);
}

/** Opens a chip's comment editor beside its quote when the quote is on screen, else beside the chip. */
function editComment(index: number, range?: Range | null) {
	unmarkQuote();
	const citation = citeChips.value[index];
	if (!citation) return;
	if (range === undefined) {
		const source = findSource(citation.messageId);
		range = source && resolveRange(source, citation);
	}
	const onScreen = range && area.value && isInside(range.getBoundingClientRect(), area.value.getBoundingClientRect());
	citeAnchor.value = range && onScreen ? quoteAnchor(range) : null;
	if (range && onScreen) unmarkQuote = markQuote(range);
	editingCite.value = index;
}

function isInside(rect: DOMRect, bounds: DOMRect) {
	return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
}

/** The quote's last line, for the editor to sit under. */
function quoteAnchor(range: Range): CiteAnchor {
	return {
		contextElement: range.startContainer.parentElement ?? undefined,
		getBoundingClientRect: () => {
			const lines = range.getClientRects();
			return lines.item(lines.length - 1) ?? range.getBoundingClientRect();
		},
	};
}

function closeComment() {
	unmarkQuote();
	editingCite.value = null;
	citeAnchor.value = null;
	composer.value?.querySelector("textarea")?.focus();
}

function saveComment(index: number, comment: string) {
	citeChips.value = citeChips.value.map((citation, at) => (at === index ? withComment(citation, comment) : citation));
	closeComment();
}

function removeCite(index: number) {
	if (editingCite.value === index) closeComment();
	else if (editingCite.value !== null && editingCite.value > index) editingCite.value--;
	citeChips.value = citeChips.value.filter((_, at) => at !== index);
	composer.value?.querySelector("textarea")?.focus();
}

/** Scrolls to the quote in its reply, rendering older messages when it is above them. */
function revealQuote(citation: Citation) {
	void revealCitation(citation, () => {
		if (firstShown.value === 0) return false;
		showEarlier();
		return true;
	});
}

const busy = computed(() => status.value === "submitted" || status.value === "streaming");
const lastMessage = computed(() => messages.value[messages.value.length - 1]);
// The copy of the thread on this device follows the chat: written when a reply ends, or when
// the chat closes mid-reply (it reconnects on the way back).
const { chatBusy, remember, added } = useThreads();
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

const { thinking, text: thinkingText } = useThinking(busy, messages);

// Messages written while a reply streams wait here; the first goes out when it ends (message-queue.ts).
const queue = useMessageQueue(props.threadId, {
	busy,
	ready: computed(() => status.value === "ready"),
	outOfCredits,
	send: sendNow,
	stopReply: stopRun,
});
const queueEditing = queue.editing;

/** While a reply streams, the message is queued; otherwise it goes out now. */
async function send(text: string, files: File[] = []) {
	const chosen = takeSkills();
	const quoted = citeChips.value;
	if (editingCite.value !== null) closeComment();
	citeChips.value = [];
	// What did not go out comes back to the field: the text, the chosen skills and the quotes.
	const giveBack = () => {
		if (!input.value) input.value = text;
		if (!skillChips.value.length) skillChips.value = chosen;
		if (!citeChips.value.length) citeChips.value = quoted;
	};
	if ((!text.trim() && !files.length && !chosen.length && !quoted.length) || uploading.value || outOfCredits.value) {
		if (outOfCredits.value) giveBack();
		return;
	}
	const attached = await upload(files);
	// The field cleared on submit; give the text back so only the files need attaching again.
	if (!attached) return giveBack();
	await queue.send({ id: crypto.randomUUID(), text, files: attached, skills: chosen, citations: quoted });
}

function sendNow({ text, files, skills: chosen, citations: quoted }: Queued) {
	const closed = closeOpenCalls(messages.value);
	if (closed) messages.value = closed;
	// The first message: the thread shows in the list now, not once the reply ends.
	if (!messages.value.some((message) => message.role === "user")) added(props.threadId, text || chosen.map(skillTitle).join(", ") || citationLabel(quoted[0]!));
	if (!chosen.length && !quoted.length) return sendMessage(files.length ? { text, files } : { text });
	// The skills go first in the message, so their instructions come before the person's text (server/workflow/skills.ts).
	// The quotes come next, so the text that follows can refer to them (server/workflow/citations.ts).
	sendMessage({
		parts: [...files, ...chosen.map(skillPart), ...quoted.map(citationPart), ...(text ? [{ type: "text" as const, text }] : [])],
	});
}

/** The run outlives the request, so Stop tells the server, then drops the stream here. */
async function stopRun() {
	await fetch(`/api/chat/${encodeURIComponent(props.threadId)}/stop`, { method: "POST" }).catch(() => undefined);
	await stop();
}

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
	const id = replyModelId(message);
	return id ? (modelName(id) ?? id) : undefined;
}

function replyModelId(message: UIMessage) {
	return (message.metadata as { model?: string } | undefined)?.model;
}
</script>

<template>
	<div ref="area" class="relative min-h-0 flex-1">
		<Transition leave-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none" leave-to-class="opacity-0" @before-leave="pinInPlace">
			<ConversationEmptyState
				v-if="landing"
				class="gap-4 !pb-8 sm:!justify-end sm:!pb-6"
			>
				<img src="/logo.png" alt="" class="size-11" />
				<div class="space-y-2">
					<p class="text-4xl-semibold text-ink-gray-9">What's on your mind?</p>
					<p class="mx-auto max-w-sm text-balance text-p-base text-ink-gray-6 dark:text-ink-gray-7">Ask anything. Pick a model below; bigger models use more of your daily credits.</p>
				</div>
			</ConversationEmptyState>
		</Transition>
		<Conversation v-if="!landing">
			<ConversationContent class="mx-auto w-full max-w-[720px] px-4 pb-8 pt-8 sm:px-5">
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
					:data-new="shownAtStart.has(message.id) ? undefined : message.role"
				>
					<Message :from="message.role">
						<MessageContent :bare="message.role === 'user'">
							<div v-if="chosenSkills(message).length || chosenCitations(message).length" data-slot="message-skills" class="flex max-w-full flex-wrap justify-end gap-1.5 self-end">
								<SkillChip v-for="name in chosenSkills(message)" :key="name" :name="name" />
								<CitationChip v-for="(citation, index) in chosenCitations(message)" :key="`quote-${index}`" :citation="citation" @reveal="revealQuote(citation)" />
							</div>
							<p
								v-for="name in askedSkills(message)"
								:key="name"
								data-slot="asked-skill"
								class="flex items-center gap-1.5 text-p-sm text-ink-gray-6"
							>
								<span class="lucide-sparkles size-3.5 shrink-0" aria-hidden="true" />
								<span>Used skill <span class="text-ink-gray-7">{{ skillTitle(name) }}</span> · You asked for it</span>
							</p>
							<!-- The text a person can quote with Cite: a finished reply's parts (cite/selection.ts). -->
							<div class="contents" :data-cite-source="message.role === 'assistant' && !isStreaming(message) ? message.id : undefined">
							<MessageParts
								:message="message"
								:streaming="isStreaming(message)"
								@approve="answerApproval($event, true)"
								@deny="answerApproval($event, false)"
							/>
							</div>
							<MessageActions
								v-if="message.role === 'assistant' && !isStreaming(message) && replyText(message)"
								data-reply-actions
							>
								<MessageCopyAction
									:value="replyText(message)"
									:class="{ 'opacity-0 transition-opacity duration-150 ease-out-strong focus-visible:opacity-100 group-hover/message:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:opacity-100': message.id !== lastReplyId }"
								/>
								<span v-if="replyModel(message)" class="pr-1 text-p-sm text-ink-gray-6" data-slot="reply-model">{{ replyModel(message) }}</span>
							</MessageActions>
							<div
								v-for="{ save, operations } in remembered.get(message.id) ?? []"
								:key="save.id"
								data-slot="memory-saved"
								:data-new="newSaves.has(save.id) || undefined"
								class="-ml-1 -mt-3 flex flex-wrap items-start gap-x-1 [@media(pointer:coarse)]:mt-0 [@media(pointer:coarse)]:items-center [@media(pointer:coarse)]:gap-x-2"
							>
								<div class="min-w-0">
									<button
										v-for="op in operations"
										:key="op.memoryId + op.op"
										type="button"
										data-slot="memory-note"
										class="flex w-fit max-w-full items-start gap-2 rounded-4 px-1 py-0.5 text-left text-p-sm text-ink-gray-6 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center hover:bg-surface-gray-2 hover:text-ink-gray-7 active:bg-surface-gray-3"
										:class="{ 'line-through': save.undoneAt }"
										title="Open Memory"
										@click="emit('openMemory')"
									>
										<span class="lucide-bookmark mt-0.5 size-4 shrink-0" aria-hidden="true" />
										<span class="min-w-0"><span class="text-ink-gray-7">{{ MEMORY_LABELS[op.op] }}:</span> {{ op.op === "forget" ? op.note : op.text }}</span>
									</button>
								</div>
								<button
									v-if="canUndo(save)"
									type="button"
									data-slot="memory-undo"
									class="touch-target rounded-4 px-1 py-0.5 text-p-sm text-ink-gray-7 underline decoration-outline-gray-3 underline-offset-2 hover:bg-surface-gray-2 hover:decoration-current hover:text-ink-gray-8 active:bg-surface-gray-3"
									@click="undoRemembered(save)"
								>
									Undo
								</button>
								<span v-else-if="save.undoneAt" class="px-1 py-0.5 text-p-sm text-ink-gray-5">Undone</span>
							</div>
						</MessageContent>
					</Message>
				</ConversationItem>
				<ConversationItem v-if="thinking">
					<Loader :text="thinkingText" />
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

	<footer ref="footer" class="mx-auto flex w-full max-w-[720px] shrink-0 flex-col gap-2 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
		<!-- Above the field on phones; under it in the middle of the page. -->
		<!-- The chips fade out with the greeting when the first message goes. -->
		<Transition leave-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none" leave-to-class="opacity-0" @before-leave="pinInPlace">
			<Suggestions v-if="landing && !outOfCredits" class="-mx-4 w-[calc(100%+2rem)] px-4 sm:[@media(pointer:coarse)]:gap-y-4 [@media(pointer:coarse)]:-my-1.5 [@media(pointer:coarse)]:py-1.5 sm:w-full [--scroll-fade-size:40px] sm:order-last sm:mx-0 sm:px-0 sm:mt-1 sm:flex-wrap sm:justify-center sm:overflow-visible sm:[mask-image:none]">
				<Suggestion v-for="suggestion in suggestions" :key="suggestion" :suggestion="suggestion" @select="send" />
			</Suggestions>
		</Transition>
		<Alert
			v-if="outOfCredits"
			theme="amber"
			title="You've used today's credits"
			:description="creditNotice.description"
			:primary-action="creditNotice.canAsk ? { label: 'Request more credits', onClick: askForMoreCredits } : undefined"
			data-slot="out-of-credits"
		/>
		<Alert v-if="uploadError" theme="red" :title="uploadError" description="Attach the files again to send them." />
		<div ref="composer" class="relative" v-bind="skillListeners">
			<SkillMenu
				v-if="skillMenuOpen && skillQuery"
				:items="skillMatches"
				:query="skillQuery.query"
				:active="skillActive"
				@choose="chooseSkill"
				@hover="(index) => (skillActive = index)"
			/>
			<PromptInputQueue v-model:editing="queueEditing" :items="queue.items.value" @steer="queue.steer" @remove="queue.remove" @update="queue.update" @reorder="queue.reorder" />
			<PromptInput
				ref="promptInput"
				v-model="input"
				queue
				:status="status"
				:disabled="uploading || outOfCredits"
				:accept="ACCEPT"
				:ready="skillChips.length > 0 || citeChips.length > 0"
				@submit="send($event.text, $event.files)"
				@stop="queue.stop"
			>
				<PromptInputHeader />
				<div v-if="skillChips.length || citeChips.length" data-slot="prompt-input-skills" class="flex flex-wrap gap-1.5 px-3 pt-3 [@media(pointer:coarse)]:gap-y-5">
					<SkillChip v-for="name in skillChips" :key="name" :name="name" removable @remove="removeSkill(name)" />
					<CitationChip
						v-for="(citation, index) in citeChips"
						:key="`${citation.messageId}:${citation.start}:${citation.end}`"
						:citation="citation"
						composer
						:editing="editingCite === index"
						:anchor="editingCite === index ? citeAnchor : null"
						@reveal="revealQuote(citation)"
						@edit="editComment(index)"
						@remove="removeCite(index)"
						@save="saveComment(index, $event)"
						@send="
							saveComment(index, $event);
							promptInput?.submit();
						"
						@cancel="closeComment"
					/>
				</div>
				<PromptInputTextarea :placeholder="placeholder" autofocus />
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputAttachButton />
						<ModelSelector v-if="models.length" v-model="threadModel" :models="models" label="Model" />
						<span v-if="uploading" class="px-1.5 text-xs text-ink-gray-6">Uploading…</span>
					</PromptInputTools>
					<PromptInputSubmit />
				</PromptInputFooter>
			</PromptInput>
		</div>
	</footer>
	<CiteButton v-if="pendingCite" :pending="pendingCite" @cite="cite" />
	<!-- As tall as the space above, so the greeting and the field sit in the middle. -->
	<div v-if="landing" class="hidden flex-1 sm:block" aria-hidden="true" />
</template>
