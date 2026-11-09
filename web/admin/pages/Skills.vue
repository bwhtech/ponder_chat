<script setup lang="ts">
import { Badge, Button, Dropdown, PageHeader, PageHeaderMobile, Switch, TabButtons, TextInput, Tooltip, dialog, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { skillTitle } from "../../../shared/skill-file";
import { api, type SkillDetail, type SkillSummary } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import NewSkillDialog from "../components/NewSkillDialog.vue";
import EmptyState from "../../EmptyState.vue";
import { lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";

/**
 * Skills (server/skills.ts): Markdown files of instructions. One that is on works for
 * everyone; an automatic one Ponder also uses on its own. The switch saves at once.
 */
const router = useRouter();
const skills = ref<SkillSummary[]>([]);
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind !== "loaded");

let asked = 0;
async function load() {
	const mine = ++asked;
	try {
		const data = await api<{ skills: SkillSummary[] }>("/skills");
		if (mine !== asked) return;
		skills.value = data.skills;
		status.value = { kind: "loaded" };
	} catch (e) {
		if (mine !== asked) return;
		if (status.value.kind === "loaded") toast.error((e as Error).message);
		else status.value = { kind: "error", message: (e as Error).message };
	}
}
function retry() {
	status.value = { kind: "loading" };
	void load();
}
void load();

const filter = ref("all");
const counted = (label: string, test: (skill: SkillSummary) => boolean) => {
	const count = skills.value.filter(test).length;
	return count ? `${label} ${count}` : label;
};
const filters = computed(() => [
	{ label: "All", value: "all" },
	{ label: counted("Automatic", (s) => s.enabled && s.automatic), value: "automatic" },
	{ label: counted("When asked", (s) => s.enabled && !s.automatic), value: "asked" },
	{ label: counted("Off", (s) => !s.enabled), value: "off" },
]);
const search = ref("");

const rows = computed(() => {
	const query = search.value.trim().toLowerCase();
	return skills.value
		.filter((s) => {
			if (filter.value === "automatic") return s.enabled && s.automatic;
			if (filter.value === "asked") return s.enabled && !s.automatic;
			if (filter.value === "off") return !s.enabled;
			return true;
		})
		.filter((s) => !query || s.name.includes(query) || s.description.toLowerCase().includes(query));
});

const emptyText = computed(() =>
	skills.value.length
		? { title: "No skills match", body: "Try another filter or search." }
		: { title: "No skills yet", body: "Write the instructions once, and everyone can use them in any chat." },
);

/** Saved at once. The switch shows the new value straight away and goes back if the save fails. */
async function setEnabled(skill: SkillSummary, enabled: boolean) {
	skill.enabled = enabled;
	try {
		await api(`/skills/${skill.id}/enabled`, { method: "PUT", body: { enabled } });
		toast.success(enabled ? `${skillTitle(skill.name)} is on for everyone` : `${skillTitle(skill.name)} is off`);
	} catch (e) {
		skill.enabled = !enabled;
		toast.error((e as Error).message);
	}
	void load();
}

function remove(skill: SkillSummary) {
	dialog.danger({
		title: `Delete ${skillTitle(skill.name)}?`,
		message: "No one can use it after this. Chats that used it keep their replies.",
		confirmLabel: "Delete",
		onConfirm: async () => {
			await api(`/skills/${skill.id}`, { method: "DELETE" });
			toast.success(`Deleted ${skillTitle(skill.name)}`);
			await load();
		},
	});
}

// New skill and Duplicate ask for a name and a description first (NewSkillDialog).
const creating = ref(false);
const copyOf = ref<SkillDetail | null>(null);
function newSkill() {
	copyOf.value = null;
	creating.value = true;
}
async function duplicate(skill: SkillSummary) {
	try {
		copyOf.value = await api<SkillDetail>(`/skills/${skill.id}`);
		creating.value = true;
	} catch (e) {
		toast.error((e as Error).message);
	}
}

const actionsFor = (skill: SkillSummary) => [
	{ label: "Edit", icon: "lucide-pencil", onClick: () => router.push(`/skills/${skill.id}`) },
	{ label: "Duplicate", icon: "lucide-copy", onClick: () => void duplicate(skill) },
	{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: () => remove(skill) },
];

const startedBy = (skill: SkillSummary) =>
	skill.automatic ? "Ponder uses it when the description fits. People can also type its name." : "Only when someone types its name in a message.";
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Skills">
		<template #prefix><AccountMenu compact /></template>
		<template #suffix><Button variant="ghost" icon="lucide-plus" aria-label="New skill" @click="newSkill" /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">Skills</h1>
			<Button variant="solid" theme="gray" icon-left="lucide-plus" label="New skill" class="ml-auto" @click="newSkill" />
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<p class="max-w-[640px] pb-4 text-p-sm text-ink-gray-6">
			A skill is a Markdown file of instructions. A skill that is on works for everyone. Ponder uses an automatic skill on its own when its
			description fits, and anyone can start any skill by typing <span class="font-mono text-ink-gray-8">$name</span> in a message.
		</p>

		<div v-if="skills.length" class="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
			<TextInput v-model="search" type="search" placeholder="Search" aria-label="Search skills" class="w-full md:order-2 md:ml-auto md:w-60">
				<template #prefix><span class="lucide-search size-4 text-ink-gray-5" aria-hidden="true" /></template>
			</TextInput>
			<div class="-mx-3 overflow-x-auto px-3 md:order-1 md:mx-0 md:px-0">
				<TabButtons v-model="filter" :options="filters" class="w-max" />
			</div>
		</div>

		<!-- Phone: a feed. Tap a row to edit; the switch saves at once. -->
		<List v-if="isMobile" :columns="['minmax(0,1fr)', 'auto']" class="-mx-3 list-row-px-3">
			<ListRows :items="loading ? [] : rows" v-slot="{ item }">
				<ListRow :route="`/skills/${item.id}`" class="py-3">
					<ListCell class="flex-col items-stretch gap-1">
						<span class="truncate font-mono text-sm" :class="item.enabled ? 'text-ink-gray-9' : 'text-ink-gray-5'">${{ item.name }}</span>
						<span class="line-clamp-2 text-p-sm text-ink-gray-6">{{ item.description }}</span>
						<span><Badge v-bind="item.automatic ? { theme: 'violet', label: 'Automatic' } : { theme: 'gray', label: 'When asked' }" variant="subtle" size="sm" /></span>
					</ListCell>
					<ListCell class="self-start" @click.stop.prevent>
						<Switch :model-value="item.enabled" :aria-label="`${skillTitle(item.name)} on for everyone`" @update:model-value="(on: boolean) => setEnabled(item, on)" />
					</ListCell>
				</ListRow>
			</ListRows>
		</List>

		<!-- Desktop: a table. A row is a link stretched under the row, so the switch and the menu can sit on top. -->
		<div v-else-if="status.kind !== 'error' && (loading || rows.length)" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
			<List :columns="['minmax(14rem,1fr)', '8rem', '4.5rem', '10rem', '2.5rem']" :row-height="60" class="min-w-[44rem] list-row-px-3">
				<ListHeader>
					<ListHeaderCell>Skill</ListHeaderCell>
					<ListHeaderCell>Started</ListHeaderCell>
					<ListHeaderCell>On</ListHeaderCell>
					<ListHeaderCell class="justify-end">Last edit</ListHeaderCell>
					<ListHeaderCell />
				</ListHeader>
				<ListRows :items="loading ? [] : rows" v-slot="{ item }">
					<ListRow class="rounded-4 hover:bg-surface-gray-2">
						<ListCell>
							<RouterLink :to="`/skills/${item.id}`" class="absolute inset-0 rounded-4" :aria-label="`Edit ${skillTitle(item.name)}`" />
							<div class="min-w-0">
								<p class="truncate font-mono text-sm" :class="item.enabled ? 'text-ink-gray-9' : 'text-ink-gray-5'">${{ item.name }}</p>
								<p class="mt-1 truncate text-sm text-ink-gray-6">{{ item.description }}</p>
							</div>
						</ListCell>
						<ListCell>
							<Tooltip :text="startedBy(item)">
								<Badge v-bind="item.automatic ? { theme: 'violet', label: 'Automatic' } : { theme: 'gray', label: 'When asked' }" variant="subtle" />
							</Tooltip>
						</ListCell>
						<ListCell>
							<Switch
								class="relative"
								:model-value="item.enabled"
								:aria-label="`${skillTitle(item.name)} on for everyone`"
								@update:model-value="(on: boolean) => setEnabled(item, on)"
							/>
						</ListCell>
						<ListCell class="justify-end">
							<div class="min-w-0 text-right">
								<p class="text-sm text-ink-gray-7">{{ lastActive(item.updatedAt) }}</p>
								<p v-if="item.updatedBy" class="mt-0.5 truncate text-xs text-ink-gray-5">{{ item.updatedBy }}</p>
							</div>
						</ListCell>
						<ListCell class="justify-end">
							<Dropdown :options="actionsFor(item)">
								<Button variant="ghost" icon="lucide-ellipsis" class="relative" :aria-label="`Actions for ${skillTitle(item.name)}`" />
							</Dropdown>
						</ListCell>
					</ListRow>
				</ListRows>
			</List>
		</div>

		<EmptyState v-if="status.kind === 'error'" icon="lucide-circle-alert" title="The skills could not load" :body="status.message" alert>
			<Button label="Try again" @click="retry" />
		</EmptyState>

		<ListSkeleton v-else-if="loading" :rows="4" :avatar="false" two-lines label="Loading skills" />

		<EmptyState v-else-if="!rows.length" icon="lucide-sparkles" :title="emptyText.title" :body="emptyText.body">
			<Button v-if="!skills.length" variant="solid" theme="gray" icon-left="lucide-plus" label="New skill" @click="newSkill" />
		</EmptyState>
	</div>

	<NewSkillDialog v-model:open="creating" :from="copyOf" />
</template>
