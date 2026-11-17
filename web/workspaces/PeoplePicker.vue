<script setup lang="ts">
import { displayName as nameToShow } from "../../shared/display-name";
import { Avatar, Button, Combobox, Select } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { me } from "../account";
import { searchPeople, type Member, type Person } from "./store";

/**
 * The people of a private workspace (ShareDialog.vue): its owner, then each member with
 * "Can ask" or "Can edit". The search asks the server (GET /api/people), so the
 * Combobox does not filter again; each row shows the name with the email after it.
 */
const props = defineProps<{ owner: Person }>();
const members = defineModel<Member[]>({ required: true });
const ownerIsMe = computed(() => me.value?.user.id === props.owner.id);

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

/**
 * A person's row, drawn as the side panel's People: one line on a wider screen. On a phone
 * the name and email take the first line, and what they can do goes under the name.
 */
const ROW = "flex flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 sm:h-8 sm:flex-nowrap sm:py-0";
const WHO = "min-w-0 flex-1 text-sm sm:truncate";
const ACCESS = "flex basis-full items-center gap-2.5 pl-[1.875rem] sm:basis-auto sm:pl-0 [@media(pointer:coarse)]:gap-x-4";

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
		<ul aria-label="People">
			<li :class="ROW">
				<Avatar :label="displayName(owner)" size="sm" class="shrink-0" />
				<p :class="WHO">
					<span class="text-ink-gray-8">{{ ownerIsMe ? "You" : displayName(owner) }}</span>
					<span class="ml-1.5 break-all text-ink-gray-6">{{ owner.email }}</span>
				</p>
				<div :class="ACCESS">
					<span class="flex h-7 w-28 shrink-0 items-center border border-transparent px-2 text-sm text-ink-gray-6">Owner</span>
					<span class="size-7 shrink-0" aria-hidden="true" />
				</div>
			</li>
			<li v-for="member in members" :key="member.id" :class="ROW" data-slot="workspace-member">
				<Avatar :label="displayName(member)" size="sm" class="shrink-0" />
				<p :class="WHO">
					<span class="text-ink-gray-8">{{ displayName(member) }}</span>
					<span class="ml-1.5 break-all text-ink-gray-6">{{ member.email }}</span>
				</p>
				<div :class="ACCESS">
					<Select v-model="member.access" :options="ACCESS_OPTIONS" size="sm" class="touch-target w-28 shrink-0" :aria-label="`What ${displayName(member)} can do`" />
					<Button variant="ghost" icon="lucide-x" class="touch-target" :aria-label="`Remove ${displayName(member)}`" @click="remove(member.id)" />
				</div>
			</li>
		</ul>
	</div>
</template>
