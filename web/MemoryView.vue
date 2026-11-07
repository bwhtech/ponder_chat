<script setup lang="ts">
import { Alert, Badge, Button, dialog, Dropdown, Skeleton, TabButtons } from "frappe-ui";
import { onMounted, ref } from "vue";
import { canUndo, fetchMemory, forgetMemory, KIND_LABELS, timeAgo, undoSave, updateMemory, type Memory, type MemoryOverview, type MemorySave } from "./memory";
import { useThreads } from "./threads";

/** What Ponder remembers about the person, the decisions behind it, and the prompt that decides. */
const emit = defineEmits<{
	/** Open the chat a memory or decision came from. */
	openThread: [id: string];
}>();

const { threads } = useThreads();
const overview = ref<MemoryOverview>();
/** The last load failed. What loaded before stays on screen under it, with Retry. */
const loadError = ref("");
const tab = ref<"memories" | "decisions" | "prompt">("memories");
const tabs = [
	{ value: "memories", label: "Memories" },
	{ value: "decisions", label: "Decisions" },
	{ value: "prompt", label: "How it decides" },
];

onMounted(load);

// Each load takes a number: after two undos, the older answer arriving last is dropped.
let asked = 0;

async function load() {
	const mine = ++asked;
	loadError.value = "";
	try {
		const next = await fetchMemory();
		if (mine === asked) overview.value = next;
	} catch (error) {
		if (mine === asked) loadError.value = (error as Error).message;
	}
}

function threadTitle(id: string | null) {
	return id ? (threads.value.find((thread) => thread.id === id)?.title ?? null) : null;
}

function menu(memory: Memory) {
	return [
		{ label: "Edit", icon: "lucide-pencil", onClick: () => askEdit(memory) },
		{ label: "Forget", icon: "lucide-trash-2", theme: "red" as const, onClick: () => askForget(memory) },
	];
}

function askEdit(memory: Memory) {
	dialog.prompt({
		title: "Edit memory",
		fields: [{ name: "text", label: "What Ponder remembers", type: "textarea", defaultValue: memory.text, required: true }],
		confirmLabel: "Save",
		onConfirm: async ({ values }) => {
			await updateMemory(memory.id, String(values.text));
			await load();
		},
	});
}

function askForget(memory: Memory) {
	dialog.danger({
		title: "Forget this?",
		message: `Ponder will stop using "${memory.text}" in new chats. You can undo this under Decisions.`,
		confirmLabel: "Forget",
		onConfirm: async () => {
			await forgetMemory(memory.id);
			await load();
		},
	});
}

const OP_LABELS = { add: "Remembered", update: "Updated", forget: "Forgot" } as const;

function applied(save: MemorySave) {
	return save.operations.filter((op) => op.status === "applied");
}

/** The decisions being undone now: each shows its own spinner. */
const undoing = ref(new Set<number>());
const undoError = ref("");

async function undo(save: MemorySave) {
	undoing.value.add(save.id);
	undoError.value = "";
	try {
		await undoSave(save.id);
		await load();
	} catch (error) {
		undoError.value = (error as Error).message;
	} finally {
		undoing.value.delete(save.id);
	}
}
</script>

<template>
	<div data-slot="memory-view" class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto w-full max-w-[770px] space-y-5 px-3 py-6 sm:px-5">
			<p class="text-p-base text-ink-gray-6">
				Ponder remembers what you tell it about yourself, your work and how you like answers, and uses it in new chats so you don't have to repeat
				yourself. It never keeps passwords, contact details, ID numbers, health details, or what you say about other people.
			</p>

			<Alert v-if="loadError" theme="red" :title="loadError" :primary-action="{ label: 'Retry', onClick: load }" />
			<Alert
				v-else-if="overview && !overview.enabled"
				theme="amber"
				title="Memory is off"
				description="The server runs with PONDER_MEMORY=off, so new chats neither use nor add memories."
			/>
			<TabButtons v-if="overview || !loadError" v-model="tab" :options="tabs" />

			<!-- Rows shaped like memories while they load: a line of text, then its kind and age. -->
			<ul
				v-if="!overview && !loadError"
				class="divide-y divide-outline-gray-1 rounded-6 border border-outline-gray-2"
				aria-busy="true"
				aria-label="Loading memories"
			>
				<li v-for="width in ['w-4/5', 'w-3/5', 'w-2/3']" :key="width" class="space-y-2 px-3 py-3">
					<Skeleton :class="['h-4 rounded-4', width]" />
					<div class="flex items-center gap-2">
						<Skeleton class="h-4 w-14 rounded-full" />
						<Skeleton class="h-3 w-16 rounded-4" />
					</div>
				</li>
			</ul>

			<template v-if="overview">
				<div v-if="tab === 'memories'">
					<ul v-if="overview.memories.length" class="divide-y divide-outline-gray-1 rounded-6 border border-outline-gray-2">
						<li v-for="memory in overview.memories" :key="memory.id" class="flex items-start gap-3 px-3 py-2.5">
							<div class="min-w-0 flex-1 space-y-1">
								<p class="text-p-base text-ink-gray-8">{{ memory.text }}</p>
								<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-gray-5">
									<Badge :label="KIND_LABELS[memory.kind]" size="sm" />
									<button
										v-if="threadTitle(memory.sourceThread)"
										type="button"
										class="truncate hover:text-ink-gray-8 hover:underline"
										@click="emit('openThread', memory.sourceThread!)"
									>
										From "{{ threadTitle(memory.sourceThread) }}"
									</button>
									<span>{{ timeAgo(memory.updatedAt) }}</span>
								</div>
							</div>
							<Dropdown :options="menu(memory)" align="end">
								<template #trigger>
									<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for ${memory.text}`" />
								</template>
							</Dropdown>
						</li>
					</ul>
					<p v-else class="rounded-6 border border-dashed border-outline-gray-2 px-3 py-4 text-p-sm text-ink-gray-5">
						Nothing yet. Tell Ponder about your work or how you like answers, or say "remember that…", and it will.
					</p>
				</div>

				<div v-else-if="tab === 'decisions'" class="space-y-2">
					<p class="text-p-sm text-ink-gray-5">
						After every reply, Ponder decides whether the chat held anything worth remembering. Most of the time it doesn't. These are its latest decisions.
					</p>
					<Alert v-if="undoError" theme="red" :title="undoError" />
					<ul v-if="overview.saves.length" class="divide-y divide-outline-gray-1 rounded-6 border border-outline-gray-2">
						<li v-for="save in overview.saves" :key="save.id" class="space-y-1 px-3 py-2.5">
							<div class="flex items-start gap-2">
								<span
									class="mt-0.5 size-4 shrink-0"
									:class="!save.ok ? 'lucide-circle-alert text-ink-red-6' : applied(save).length ? 'lucide-brain text-ink-gray-7' : 'lucide-circle-minus text-ink-gray-4'"
									aria-hidden="true"
								/>
								<p class="min-w-0 flex-1 text-p-base" :class="applied(save).length ? 'text-ink-gray-8' : 'text-ink-gray-6'">{{ save.summary }}</p>
								<Badge v-if="save.undoneAt" label="Undone" size="sm" />
								<Button v-else-if="canUndo(save)" variant="ghost" size="sm" label="Undo" :loading="undoing.has(save.id)" @click="undo(save)" />
							</div>
							<ul v-if="applied(save).length" class="space-y-0.5 pl-6">
								<li v-for="op in applied(save)" :key="op.memoryId + op.op" class="text-p-sm text-ink-gray-6" :class="{ 'line-through': save.undoneAt }">
									<span class="text-ink-gray-8">{{ OP_LABELS[op.op] }}:</span> {{ op.op === "forget" ? op.note : op.text }}
								</li>
							</ul>
							<p v-if="save.error" class="pl-6 text-p-sm text-ink-red-6">{{ save.error }}</p>
							<div class="flex flex-wrap gap-x-2 pl-6 text-sm text-ink-gray-5">
								<button
									v-if="threadTitle(save.threadId)"
									type="button"
									class="truncate hover:text-ink-gray-8 hover:underline"
									@click="emit('openThread', save.threadId!)"
								>
									"{{ threadTitle(save.threadId) }}"
								</button>
								<span>{{ timeAgo(save.createdAt) }}</span>
								<span v-if="save.model">{{ save.model }}</span>
							</div>
						</li>
					</ul>
					<p v-else class="rounded-6 border border-dashed border-outline-gray-2 px-3 py-4 text-p-sm text-ink-gray-5">No decisions yet.</p>
				</div>

				<div v-else class="space-y-2">
					<p class="text-p-sm text-ink-gray-5">
						After each reply, a decision model answers two questions, and only on a yes does a small model write the changes. Both live in
						<code class="rounded-2 bg-surface-gray-2 px-1 text-ink-gray-8">server/memory/</code>. Search: {{ overview.adapter }}.
					</p>
					<pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-6 border border-outline-gray-2 bg-surface-gray-1 p-3 text-p-sm text-ink-gray-8">{{ overview.prompt }}</pre>
				</div>
			</template>
		</div>
	</div>
</template>
