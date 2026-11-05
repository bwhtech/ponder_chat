<script setup lang="ts">
import { dialog, Dropdown, SidebarItem, SidebarLabel, Skeleton } from "frappe-ui";
import { computed } from "vue";
import { useThreads, type ThreadSummary } from "./threads";

/** The person's threads, grouped by when they were last active. Each row has rename and delete. */
const props = withDefaults(defineProps<{ /** Highlight the open thread; off while another page fills the main area. */ highlight?: boolean }>(), {
	highlight: true,
});
const emit = defineEmits<{
	/** A thread was picked: the shell opens it and closes the sheet on a phone. */
	select: [id: string];
}>();

const { threads, listLoaded, current, prefetch, rename, remove } = useThreads();

const groups = computed(() => {
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	const day = 24 * 60 * 60 * 1000;
	const buckets: [string, (time: number) => boolean][] = [
		["Today", (time) => time >= startOfToday],
		["Yesterday", (time) => time >= startOfToday - day],
		["Previous 7 days", (time) => time >= startOfToday - 7 * day],
		["Older", () => true],
	];
	const grouped = buckets.map(([label]) => ({ label, threads: [] as ThreadSummary[] }));
	for (const thread of threads.value) {
		const time = new Date(thread.updatedAt).getTime();
		grouped[buckets.findIndex(([, matches]) => matches(time))].threads.push(thread);
	}
	return grouped.filter((group) => group.threads.length);
});

function menu(thread: ThreadSummary) {
	return [
		{ label: "Rename", icon: "lucide-pencil", onClick: () => askRename(thread) },
		{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => askDelete(thread) },
	];
}

function askRename(thread: ThreadSummary) {
	dialog.prompt({
		title: "Rename thread",
		fields: [{ name: "title", label: "Name", defaultValue: thread.title, required: true }],
		confirmLabel: "Rename",
		onConfirm: ({ values }) => rename(thread.id, String(values.title)),
	});
}

function askDelete(thread: ThreadSummary) {
	dialog.danger({
		title: "Delete this thread?",
		message: `"${thread.title}" and its messages will be deleted.`,
		onConfirm: () => remove(thread.id),
	});
}
</script>

<template>
	<nav data-slot="thread-list" aria-label="Threads" class="flex flex-col gap-3">
		<div v-for="group in groups" :key="group.label" class="space-y-0.5">
			<SidebarLabel>{{ group.label }}</SidebarLabel>
			<SidebarItem
				v-for="thread in group.threads"
				:key="thread.id"
				:label="thread.title"
				:active="props.highlight && thread.id === current"
				@click="emit('select', thread.id)"
				@pointerenter="prefetch(thread.id)"
				@focusin="prefetch(thread.id)"
				@touchstart.passive="prefetch(thread.id)"
			>
				<template #suffix>
					<Dropdown :options="menu(thread)" align="end">
						<template #trigger>
							<button
								type="button"
								class="flex size-6 items-center justify-center rounded-4 text-ink-gray-5 hover:bg-surface-gray-3 hover:text-ink-gray-8"
								:aria-label="`Actions for ${thread.title}`"
							>
								<span class="lucide-ellipsis size-4" aria-hidden="true" />
							</button>
						</template>
					</Dropdown>
				</template>
			</SidebarItem>
		</div>
		<div v-if="!listLoaded" class="space-y-0.5" aria-busy="true" aria-label="Loading threads">
			<Skeleton class="mx-2 mb-2 mt-1.5 h-3 w-14 rounded-4" />
			<div v-for="width in ['w-40', 'w-32', 'w-44', 'w-28', 'w-36']" :key="width" class="flex h-7 items-center px-2">
				<Skeleton :class="['h-3.5 rounded-4', width]" />
			</div>
		</div>
		<p v-else-if="!threads.length" class="px-2 text-p-sm text-ink-gray-5">Your threads show up here once you start one.</p>
	</nav>
</template>
