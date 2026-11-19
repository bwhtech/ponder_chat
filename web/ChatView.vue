<script setup lang="ts">
import BrandLogo from "./BrandLogo.vue";
import type { FileUIPart, UIMessage } from "ai";
import { Button } from "frappe-ui";
import { Alert, OutOfCredits } from "./lazy-alert";
import { computed, getCurrentScope, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import { me } from "./account";
import { client } from "./api";
import { useDraft } from "./drafts";
import { canUndo, MEMORY_LABELS, useRememberedNotes } from "./remembered-notes";
import { closeOpenCalls, useMessageQueue, waitingOnPerson, type Queued } from "./message-queue";
import { isAuto } from "../shared/auto-model";
import { acceptedFiles, defaultModel, features, ModelSelector, modelName, models } from "./models";
import { chosenCitations, citationLabel, citationPart, withComment, type Citation } from "./cite/citations";
import type { CiteAnchor, PendingCite } from "./cite/selection";
import { SkillMenu, useSkillPicker } from "./skills/picker";
import { chosenSkills, loadSkills, skillPart, skillTitle, withSkillsHint } from "./skills/skills";
import { summarizedThrough } from "./compaction";
import { THREAD_CHANGED } from "../shared/replies";
import { useThreads } from "./threads";
import { useLazyChat } from "./lazy-chat";
import { once } from "./once";
import { isRecord } from "./json";
import { preloadChat } from "./preload";
import { useChatWorkspace, WorkspacePicker } from "./workspaces/chat-workspace";
import { askedWith, offersWebSearch, savedWebChoice, useWebTools, webLabel, withWebOnce } from "./web-tools";
import WebTools from "./WebTools.vue";
// The replies, their parts and the quotes are their own chunk (transcript.ts): a new chat draws without them.
import {
	CitationChip,
	CiteSelection,
	CompactionDivider,
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
	loadTranscript,
	SkillChip,
	ToolContext,
	transcriptReady,
} from "./transcript-parts";
import ThreadSkeleton from "./ThreadSkeleton.vue";
import {
	ConversationEmptyState,
	PromptInput,
	PromptInputAttachButton,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputQueue,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	Suggestion,
	Suggestions,
} from "frappe-ui-ai-elements";

/**
 * One chat: the conversation and the message field. The shell mounts a new one per thread.
 * `workspaceId` is the saved chat's workspace; a new chat picks one in the composer.
 */
const props = defineProps<{ threadId: string; initialMessages: UIMessage[]; running?: boolean; failed?: boolean; workspaceId?: string }>();
const emit = defineEmits<{
	/** A reply finished and the thread was saved: its place in the list and the credits left changed. */
	saved: [];
	/** A request failed, perhaps for want of credits: the shell asks how many are left. */
	refused: [];
	/** The person wants to see or change what Ponder remembers. */
	openMemory: [];
}>();

// The model for this chat: the one that wrote its last reply, so going back to a chat
// brings back its model. A new chat starts on the default, Auto (models.ts).
const threadModel = ref(lastReplyModel(props.initialMessages) ?? defaultModel.value);
// A model that left the list, or a chat that opened before the list loaded, gets the default.
watch(
	models,
	(options) => {
		if (options.length && !options.some((option) => option.id === threadModel.value)) threadModel.value = defaultModel.value;
	},
	{ immediate: true },
);

function lastReplyModel(messages: UIMessage[]) {
	const reply = messages.findLast((message) => message.role === "assistant" && replyModelId(message));
	return reply && replyModelId(reply);
}

// The chat's workspace (workspaces/chat-workspace.ts), and a question asked on a workspace page, sent as the first message.
const workspace = useChatWorkspace(
	props.threadId,
	() => props.workspaceId,
	() => messages.value.some((message) => message.role === "user"),
);
if (workspace.firstMessage?.model) threadModel.value = workspace.firstMessage.model;
// Web and Research (web-tools.ts): a saved chat starts as its last message was sent, a new one as its workspace says.
const webTools = useWebTools(() => Boolean(workspace.chosen.value), savedWebChoice(props.initialMessages));
if (workspace.firstMessage) webTools.restore(workspace.firstMessage.web);

/** The server said the saved thread is ahead of this page (THREAD_CHANGED). */
let threadChanged = false;
// The AI SDK loads beside the page (lazy-chat.ts); the messages show without it.
const { messages, sendMessage, addToolApprovalResponse, status, error, stop, regenerate, resumeStream } = useLazyChat(({ WorkflowChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses }) => ({
	id: props.threadId,
	// Each reply is a durable workflow run on the server. When the connection drops before
	// the reply ends (a server restart, a flaky network), the transport reconnects to the
	// run and picks up where it left off. The model goes with every request.
	transport: new WorkflowChatTransport({
		api: "/api/chat",
		prepareSendMessagesRequest: ({ id, messages }) => ({
			headers: { "Content-Type": "application/json" },
			// The server reads the workspace on the chat's first message only.
			body: { id, messages, model: threadModel.value, workspaceId: workspace.chosen.value ?? undefined },
		}),
		fetch: patientFetch,
	}),
	// A connector tool on "Ask first" waits for the person; their answer goes out at once.
	sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
	// The server answers an approval that was used already with this, and no run (server/workflow/replies.ts):
	// the saved thread is ahead of this page, so the page loads it once the reply ends.
	onData: (part) => {
		if (part.type === THREAD_CHANGED) threadChanged = true;
	},
	onFinish: () => {
		emit("saved");
		void notes.load({ wait: true });
	},
	onError: () => {
		emit("refused");
		// Perhaps removed from the chat's workspace meanwhile: the list says so, and the composer closes.
		workspace.recheck();
	},
}), props.initialMessages);

/**
 * fetch for the transport: reconnecting to a reply (a GET) waits and tries again for up
 * to 30 seconds while the server is unreachable or restarting: 502, 503 and 504 from the
 * proxy, and a 500 from a server that is stopping and has closed its database. Sending a
 * message (a POST) is never repeated, so it cannot start a reply twice.
 */
async function patientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if ((init?.method ?? "GET") !== "GET") return fetch(input, init);
	const deadline = Date.now() + 30_000;
	for (let attempt = 0; ; attempt++) {
		try {
			const response = await fetch(input, init);
			if (response.status < 500 || Date.now() > deadline) return response;
		} catch (error) {
			if (init?.signal?.aborted || Date.now() > deadline) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 3_000)));
	}
}

// A chat with messages needs the transcript's code to draw them; the skeleton stands in until it is here.
if (props.initialMessages.length) void loadTranscript().catch(() => undefined);

const notes = useRememberedNotes(props.threadId);
const { byMessage: remembered, fresh: newSaves, undo: undoRemembered } = notes;

onMounted(() => {
	// A new chat has no replies, so nothing was remembered from it yet.
	if (props.initialMessages.length) void notes.load();
	// The reply was still being written when the thread loaded (after a reload, say): follow it.
	if (props.running) void resumeStream();
	const first = workspace.firstMessage;
	if (!first) return;
	skillChips.value = first.skills;
	void send(first.text, first.files);
});

const outOfCredits = computed(() => (me.value?.credits.remaining ?? 1) <= 0);


const input = ref("");
// What the person was writing in this chat comes back after a switch or a reload.
useDraft(props.threadId, input);
// Typing a message: the code to send it and show the reply loads now, if the page has not loaded it yet.
watch(input, () => void preloadChat(), { once: true });
const uploading = ref(false);
const uploadError = ref("");

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
// A chat in a workspace names it, as the workspace page does: the header's breadcrumb leads back to it.
const askIn = computed(() => workspace.summary.value?.name);
// Deep research on for the next message: the field says so, where the eye already is.
const placeholder = computed(() => (webTools.research.value ? "Ask a research question" : withSkillsHint(askIn.value ? `Ask in ${askIn.value}` : "Message Ponder Chat")));

/** The skills the person asked for in the message this reply answers, for the line above the reply. */
function askedSkills(message: UIMessage) {
	if (message.role !== "assistant") return [];
	return chosenSkills(messages.value[messages.value.indexOf(message) - 1]);
}

// The replies' tool steps show and label themselves through ToolContext.vue, in the transcript, which
// also loads the connectors. When a call waits for approval, "Always allow" saves its rule, then approves.

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
/** The newest reply keeps its copy button in view; older ones show it on hover. The model name always shows, except under Auto. */
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
// stays at the bottom, by the thumb and the keyboard). The first message sends it down. A
// question asked on a workspace page is that first message: the chat opens as sent, with no
// greeting, and its field slides in from where the page's box was.
const landing = computed(() => messages.value.length === 0 && !workspace.firstMessage);
const area = ref<HTMLElement | null>(null);
const footer = ref<HTMLElement | null>(null);
let footerTop = 0;
// Before the page re-renders: where the field is now.
watch(landing, () => (footerTop = footer.value?.getBoundingClientRect().top ?? 0), { flush: "pre" });
watch(landing, (now) => !now && footer.value && settleFooter(0, footerTop - footer.value.getBoundingClientRect().top), { flush: "post" });
onMounted(() => {
	const from = workspace.firstMessage?.from;
	const box = composer.value?.getBoundingClientRect();
	if (from && box) settleFooter(from.left - box.left, from.bottom - box.bottom);
});

/**
 * The field moves from where it was, `dx` and `dy` away, to its place at the bottom. The first
 * message shows at once, like every message you send. Only the place animates: a field of
 * another width takes its own at once.
 */
function settleFooter(dx: number, dy: number) {
	const field = footer.value;
	if (!field || (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out-strong").trim() || "ease-out";
	field.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 300, easing });
}

/** The greeting fades out where it stood, out of the layout, so it does not hold the field up. */
function pinInPlace(element: Element) {
	const el = element as HTMLElement;
	const { top, left, width, height } = el.getBoundingClientRect();
	Object.assign(el.style, { position: "fixed", top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
}

// Citations: selecting text in a reply shows a Cite button (cite/CiteSelection.vue, in the
// transcript). Cite puts the quote in the message box as a chip and opens a field for an
// optional comment, beside the quoted text, which stays marked while the comment is written.
// Adapted from T3 Code.
const promptInput = ref<{ submit: () => void } | null>(null);
const citeChips = ref<Citation[]>([]);
/** The chip whose comment is open, and what its editor sits against: the quote, or the chip. */
const editingCite = ref<number | null>(null);
const citeAnchor = ref<CiteAnchor | null>(null);
let unmarkQuote = () => {};
/**
 * The open editor belongs to a quote Cite just added. Like T3 Code, cancelling that first
 * comment (Cancel, Escape, or a click away with nothing written) takes the quote out again;
 * only Save keeps it. Cancelling a later edit (the pencil) only closes the editor.
 */
let newCite = false;
onBeforeUnmount(() => unmarkQuote());

function cite(shown: PendingCite) {
	citeChips.value = [...citeChips.value, shown.citation];
	editComment(citeChips.value.length - 1, shown.range);
	newCite = true;
}

/**
 * Opens a chip's comment editor beside its quote when the quote is on screen, else beside the
 * chip. Finding and marking the quote are in the transcript's chunk, which a chat with quotes
 * has loaded: the editor opens once they answer, a moment later.
 */
function editComment(index: number, range?: Range | null) {
	newCite = false;
	unmarkQuote();
	const citation = citeChips.value[index];
	if (!citation) return;
	void loadTranscript().then(({ findSource, markQuote, resolveRange }) => {
		// Something else opened, or the chip went, meanwhile.
		if (citeChips.value[index] !== citation || (editingCite.value !== null && editingCite.value !== index)) return;
		if (range === undefined) {
			const source = findSource(citation.messageId);
			range = source && resolveRange(source, citation);
		}
		const onScreen = range && area.value && isInside(range.getBoundingClientRect(), area.value.getBoundingClientRect());
		citeAnchor.value = range && onScreen ? quoteAnchor(range) : null;
		if (range && onScreen) unmarkQuote = markQuote(range);
		editingCite.value = index;
	});
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
	newCite = false;
	unmarkQuote();
	editingCite.value = null;
	citeAnchor.value = null;
	composer.value?.querySelector("textarea")?.focus();
}

/** Cancel, Escape, or a click away that changed nothing. */
function cancelComment(index: number) {
	if (newCite) removeCite(index);
	else closeComment();
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
	void loadTranscript().then(({ revealCitation }) =>
		revealCitation(citation, () => {
			if (firstShown.value === 0) return false;
			showEarlier();
			return true;
		}),
	);
}

const busy = computed(() => status.value === "submitted" || status.value === "streaming");
const lastMessage = computed(() => messages.value[messages.value.length - 1]);
// The thread's last reply failed before this page opened it (the model kept erroring). Retry
// stays until the next reply starts; a reply that fails while the page is open sets `error`.
const failedBefore = ref(Boolean(props.failed && !props.running));
// The copy of the thread on this device follows the chat: written when a reply ends, or when
// the chat closes mid-reply (it reconnects on the way back).
const { chatBusy, remember, added, reload } = useThreads();
watch(
	busy,
	(now, before) => {
		chatBusy.value = now;
		if (now) failedBefore.value = false;
		if (before && !now) remember(props.threadId, { messages: messages.value, running: false, failed: Boolean(error.value), workspaceId: workspace.chosen.value ?? undefined });
		if (before && !now && threadChanged) {
			threadChanged = false;
			void reload(props.threadId);
		}
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (busy.value) remember(props.threadId, { messages: messages.value, running: true, workspaceId: workspace.chosen.value ?? undefined });
	chatBusy.value = false;
});

// "Thinking" (thinking.ts), and a count on the favicon for a reply that finishes while the tab
// is hidden (attention.ts), start with the chat's first reply: a new chat that sends nothing
// loads neither. The page prefetches them once it has loaded (boot-page.ts).
const scope = getCurrentScope();
const replyState = shallowRef<{ thinking: Ref<boolean>; text: Ref<string> }>();
const thinking = computed(() => replyState.value?.thinking.value ?? false);
const thinkingText = computed(() => replyState.value?.text.value ?? "Thinking");
const startReplyHelpers = once(() =>
	Promise.all([import("./thinking"), import("./attention")]).then(([{ useThinking }, { useAttention }]) => {
		if (!scope?.active) return;
		scope.run(() => {
			replyState.value = useThinking(busy, messages);
			useAttention(busy, computed(() => waitingOnPerson(messages.value)));
		});
	}),
);
watch(busy, (now) => now && void startReplyHelpers().catch(() => undefined), { immediate: true });
/** "Thinking" sits in the reply's place before the reply exists: the turn after the person's message. */
/** The last message the newest summary covers: a divider follows it. */
const summarized = computed(() => summarizedThrough(messages.value));
const thinkingAlone = computed(() => thinking.value && lastMessage.value?.role !== "assistant");
// The reply that takes over that place is already on screen, so it does not rise in.
watch(
	() => lastMessage.value?.id,
	() => {
		if (thinking.value && lastMessage.value?.role === "assistant") shownAtStart.add(lastMessage.value.id);
	},
);

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
	const web = webTools.take();
	const quoted = citeChips.value;
	if (editingCite.value !== null) closeComment();
	citeChips.value = [];
	// What did not go out comes back to the field: the text, the chosen skills and the quotes.
	const giveBack = () => {
		if (!input.value) input.value = text;
		if (!skillChips.value.length) skillChips.value = chosen;
		if (!citeChips.value.length) citeChips.value = quoted;
		webTools.restore(web);
	};
	if ((!text.trim() && !files.length && !chosen.length && !quoted.length) || uploading.value || outOfCredits.value || workspace.lostAccess.value) {
		if (outOfCredits.value) giveBack();
		return;
	}
	const attached = await upload(files);
	// The field cleared on submit; give the text back so only the files need attaching again.
	if (!attached) return giveBack();
	await queue.send({ id: crypto.randomUUID(), text, files: attached, skills: chosen, citations: quoted, web });
}

function sendNow({ text, files, skills: chosen, citations: quoted, web }: Queued) {
	const closed = closeOpenCalls(messages.value);
	if (closed) messages.value = closed;
	// The first message: the thread shows in the list now, not once the reply ends.
	if (!messages.value.some((message) => message.role === "user")) added(props.threadId, text || chosen.map(skillTitle).join(", ") || citationLabel(quoted[0]!), workspace.chosen.value ?? undefined);
	// The web choice rides in the message's metadata, so it is saved with the thread (shared/web-mode.ts).
	if (!chosen.length && !quoted.length) return sendMessage(files.length ? { text, files, metadata: web } : { text, metadata: web });
	// The skills go first in the message, so their instructions come before the person's text (server/workflow/skills.ts).
	// The quotes come next, so the text that follows can refer to them (server/workflow/citations.ts).
	sendMessage({
		parts: [...files, ...chosen.map(skillPart), ...quoted.map(citationPart), ...(text ? [{ type: "text" as const, text }] : [])],
		metadata: web,
	});
}

/** What a reply used, for the line under it: "Sources only", "Sources + web" or "Deep research". */
function replyWeb(message: UIMessage) {
	return webLabel(askedWith(messages.value, message), Boolean(workspace.chosen.value));
}

/**
 * The newest reply found no answer in the workspace's Sources and offers the web
 * (offer_web_search). Not once the chat's web search is on: the next message searches anyway.
 */
function offersWeb(message: UIMessage) {
	return message.id === lastReplyId.value && message === lastMessage.value && !busy.value && !outOfCredits.value && !workspace.lostAccess.value && offersWebSearch(message);
}

/** "Search the web for this": the same question again, with one web search. The chat's own setting stays. */
function searchWebOnce() {
	messages.value = withWebOnce(messages.value, webTools.kept.value);
	void regenerate();
}

/** The run outlives the request, so Stop tells the server, then drops the stream here. */
async function stopRun() {
	await client.api.chat[":id"].stop.$post({ param: { id: encodeURIComponent(props.threadId) } }).catch(() => undefined);
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
				const result: unknown = await response.json().catch(() => null);
				if (!response.ok || !isUploaded(result)) throw new Error(refusalOf(result) ?? `"${file.name}" could not be uploaded.`);
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

/** The stored file that POST /api/files answers (StoredFile in server/files.ts). */
function isUploaded(value: unknown): value is { mediaType: string; name: string; url: string } {
	return isRecord(value) && typeof value.mediaType === "string" && typeof value.name === "string" && typeof value.url === "string";
}

/** The server's reason for refusing an upload, such as a file too large. */
function refusalOf(value: unknown) {
	return isRecord(value) && typeof value.error === "string" ? value.error : undefined;
}

function isStreaming(message: UIMessage) {
	return busy.value && message === lastMessage.value;
}

function replyText(message: UIMessage) {
	return message.parts.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n\n");
}

/** The model that wrote a reply, from the metadata the server attaches. None under Auto. */
function replyModel(message: UIMessage) {
	const id = replyModelId(message);
	return id && !isAuto(id) ? (modelName(id) ?? id) : undefined;
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
				<BrandLogo class="size-11" />
				<div class="space-y-2">
					<p class="text-4xl-semibold text-ink-gray-9">What's on your mind?</p>
					<p class="mx-auto max-w-sm text-balance text-p-base text-ink-gray-6 dark:text-ink-gray-7">Ask anything.</p>
				</div>
			</ConversationEmptyState>
		</Transition>
		<!-- Opened before the transcript's code loaded: the skeleton, not an empty chat. A new chat preloads it as its first message is typed. -->
		<ThreadSkeleton v-if="!landing && !transcriptReady && initialMessages.length" :composer="false" />
		<ToolContext v-else-if="!landing" :messages="messages" :send="send">
			<Conversation>
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
								<Loader v-if="thinking && message === lastMessage && message.role === 'assistant'" :text="thinkingText" />
								<div v-if="offersWeb(message)" data-slot="offer-web-search">
									<Button variant="outline" size="sm" icon-left="lucide-globe" class="touch-target" @click="searchWebOnce">Search the web for this</Button>
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
									<span v-if="replyWeb(message)" class="pr-1 text-p-sm text-ink-gray-6" data-slot="reply-web"><span v-if="replyModel(message)" aria-hidden="true">· </span>{{ replyWeb(message) }}</span>
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
						<CompactionDivider v-if="message.id === summarized" />
					</ConversationItem>
					<ConversationItem v-if="thinkingAlone">
						<Message from="assistant">
							<MessageContent><Loader :text="thinkingText" /></MessageContent>
						</Message>
					</ConversationItem>
					<ConversationItem v-if="(error || failedBefore) && !outOfCredits && !workspace.lostAccess.value">
						<Alert
							theme="red"
							title="Something went wrong"
							:description="error?.message ?? 'The last reply did not finish. Retry, or choose another model.'"
							:primary-action="{ label: 'Retry', onClick: () => regenerate() }"
						/>
					</ConversationItem>
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>
		</ToolContext>
	</div>

	<footer ref="footer" class="scroll-gutter-match flex shrink-0 flex-col gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5">
		<!-- Above the field on phones; under it in the middle of the page. -->
		<!-- The chips fade out with the greeting when the first message goes. With a workspace
		     picked they go too, but keep their space under a centred composer, so it does not
		     jump under the pointer. -->
		<Transition leave-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none" leave-to-class="opacity-0" @before-leave="pinInPlace">
			<Suggestions v-if="landing && !outOfCredits" :class="{ 'max-sm:hidden sm:invisible': askIn }" :inert="!!askIn" class="-mx-4 w-[calc(100%+2rem)] px-4 sm:[@media(pointer:coarse)]:gap-y-4 [@media(pointer:coarse)]:-my-1.5 [@media(pointer:coarse)]:py-1.5 sm:w-full [--scroll-fade-size:40px] sm:order-last sm:mx-0 sm:px-0 sm:mt-1 sm:flex-wrap sm:justify-center sm:overflow-visible sm:[mask-image:none]">
				<Suggestion v-for="suggestion in suggestions" :key="suggestion" :suggestion="suggestion" @select="send" />
			</Suggestions>
		</Transition>
		<OutOfCredits v-if="outOfCredits" />
		<!-- The server's own words for a send it refuses (server/workflow/replies.ts). -->
		<Alert
			v-if="workspace.lostAccess.value"
			data-slot="workspace-access-lost"
			theme="amber"
			title="You no longer have access to this chat's workspace."
			description="You can read this chat, but not send in it."
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
				:disabled="uploading || outOfCredits || workspace.lostAccess.value"
				:accept="acceptedFiles"
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
						@cancel="cancelComment(index)"
					/>
				</div>
				<PromptInputTextarea :placeholder="placeholder" autofocus />
				<PromptInputFooter>
					<PromptInputTools>
						<PromptInputAttachButton />
						<WebTools v-model:web="webTools.web.value" v-model:research="webTools.research.value" :in-workspace="Boolean(workspace.chosen.value)" :disabled="outOfCredits || workspace.lostAccess.value" />
						<ModelSelector v-if="models.length" v-model="threadModel" :models="models" label="Model" />
						<WorkspacePicker v-if="workspace.pickable.value" v-model="workspace.chosen.value" />
						<span v-if="uploading" class="px-1.5 text-xs text-ink-gray-6">Uploading…</span>
					</PromptInputTools>
					<PromptInputSubmit />
				</PromptInputFooter>
			</PromptInput>
		</div>
	</footer>
	<CiteSelection v-if="!landing" :area="area" @cite="cite" />
	<!-- As tall as the space above, so the greeting and the field sit in the middle. -->
	<div v-if="landing" class="hidden flex-1 sm:block" aria-hidden="true" />
</template>
