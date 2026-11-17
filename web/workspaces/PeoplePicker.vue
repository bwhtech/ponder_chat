<script setup lang="ts">
import { displayName as nameToShow } from "../../shared/display-name";
import { Button, Combobox, Select } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { me } from "../account";
import ShareRow from "./ShareRow.vue";
import { searchPeople, type Member, type Person } from "./store";

/**
 * The people of a private workspace (ShareDialog.vue): its owner, then each member with
 * "Can ask" or "Can edit". The search asks the server (GET /api/people), so the
 * Combobox does not filter again. Each person's row is ShareRow.vue.
 */
const props = defineProps<{ owner: Person }>();
const members = defineModel<Member[]>({ required: true });
const ownerIsMe = computed(() => me.value?.user.id === props.owner.id);
// Tailwind's sm.
const wide = matchMedia("(min-width: 640px)").matches;

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
		<!-- The dialog opens in the search on a wider screen (frappe-ui's Dialog focuses [autofocus]).
		     On a phone the keyboard would cover the people, so it does not. -->
		<div :autofocus="wide">
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
		</div>
		<ul aria-label="People">
			<ShareRow :avatar="displayName(owner)" :name="ownerIsMe ? 'You' : displayName(owner)" :email="ownerIsMe ? undefined : owner.email" owner />
			<ShareRow v-for="member in members" :key="member.id" :avatar="displayName(member)" :name="displayName(member)" :email="member.email" data-slot="workspace-member">
				<Select v-model="member.access" :options="ACCESS_OPTIONS" size="sm" class="touch-target w-28 shrink-0" :aria-label="`What ${displayName(member)} can do`" />
				<Button variant="ghost" icon="lucide-x" class="touch-target" :aria-label="`Remove ${displayName(member)}`" @click="remove(member.id)" />
			</ShareRow>
		</ul>
	</div>
</template>
