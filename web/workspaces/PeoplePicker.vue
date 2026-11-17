<script setup lang="ts">
import { displayName as nameToShow } from "../../shared/display-name";
import { Avatar, Button, Combobox, Select } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { searchPeople, type Member, type Person } from "./store";

/**
 * The people of a private workspace (ShareDialog.vue): its owner, then each member with
 * "Can ask" or "Can edit". The search asks the server (GET /api/people), so the
 * Combobox does not filter again; each row shows the name with the email under it.
 */
const props = defineProps<{ owner: Person }>();
const members = defineModel<Member[]>({ required: true });

const query = ref("");
const results = ref<readonly Person[]>([]);
const searching = ref(false);
const searchError = ref("");
const picked = ref<string | null>(null);
// Each search takes a number: a slower answer to an older query is dropped.
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const options = computed(() =>
	results.value
		.filter((person) => person.id !== props.owner.id && !members.value.some((member) => member.id === person.id))
		.map((person) => ({ label: displayName(person), value: person.id, description: person.email })),
);

watch(query, (text) => {
	clearTimeout(timer);
	timer = setTimeout(() => void search(text), 150);
});

watch(picked, (id) => {
	const person = results.value.find((each) => each.id === id);
	if (!person) return;
	members.value = [...members.value, { ...person, access: "ask" }];
	picked.value = null;
	query.value = "";
});

async function search(text: string) {
	const mine = ++asked;
	searching.value = true;
	try {
		const found = await searchPeople(text.trim());
		if (mine === asked) [results.value, searchError.value] = [found, ""];
	} catch (error) {
		if (mine === asked) searchError.value = (error as Error).message;
	} finally {
		if (mine === asked) searching.value = false;
	}
}

/** A new search each time the list opens, starting from the first people. */
function onOpen(open: boolean) {
	if (!open) return;
	query.value = "";
	void search("");
}

function remove(id: string) {
	members.value = members.value.filter((member) => member.id !== id);
}

function displayName(person: Person) {
	return nameToShow(person.name, person.email);
}

const ACCESS_OPTIONS = [
	{ label: "Can ask", value: "ask" },
	{ label: "Can edit", value: "edit" },
];
</script>

<template>
	<div class="space-y-2">
		<Combobox
			v-model="picked"
			class="w-full"
			v-model:query="query"
			:options="options"
			:filterable="false"
			:loading="searching && !options.length"
			:empty-text="searchError || (query.trim() ? 'Nobody matches' : 'Nobody else to add')"
			placeholder="Add people by name or email"
			aria-label="Add people by name or email"
			@update:open="onOpen"
		/>
		<ul class="divide-y divide-outline-gray-1" aria-label="People">
			<li class="flex min-h-11 items-center gap-2.5 py-1.5">
				<Avatar :label="displayName(owner)" size="md" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm text-ink-gray-8">{{ displayName(owner) }}</p>
					<p class="truncate text-xs text-ink-gray-6">{{ owner.email }}</p>
				</div>
				<span class="w-28 shrink-0 pr-2 text-right text-sm text-ink-gray-6">Owner</span>
				<span class="size-7 shrink-0" aria-hidden="true" />
			</li>
			<li v-for="member in members" :key="member.id" class="flex min-h-11 items-center gap-2.5 py-1.5" data-slot="workspace-member">
				<Avatar :label="displayName(member)" size="md" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm text-ink-gray-8">{{ displayName(member) }}</p>
					<p class="truncate text-xs text-ink-gray-6">{{ member.email }}</p>
				</div>
				<Select v-model="member.access" :options="ACCESS_OPTIONS" size="sm" class="w-28 shrink-0" :aria-label="`What ${displayName(member)} can do`" />
				<Button variant="ghost" icon="lucide-x" class="touch-target" :aria-label="`Remove ${displayName(member)}`" @click="remove(member.id)" />
			</li>
		</ul>
	</div>
</template>
