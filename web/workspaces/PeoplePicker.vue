<script setup lang="ts">
import { displayName } from "../../shared/display-name";
import { Combobox } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { ADD_PEOPLE } from "./dialogs";
import { searchPeople, type Person } from "./store";

/**
 * Share's "Add people" field (ShareDialog.vue): it searches people by name or email, and a
 * person picked from it is added at once (`pick`). The search asks the server (GET
 * /api/people), so the Combobox does not filter again. People already in the workspace
 * (`exclude`) are not offered.
 */
const props = defineProps<{ exclude: string[] }>();
const emit = defineEmits<{ pick: [person: Person] }>();
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
		.filter((person) => !props.exclude.includes(person.id))
		.map((person) => ({ label: displayName(person.name, person.email), value: person.id, description: person.email })),
);

watch(query, (text) => {
	clearTimeout(timer);
	timer = setTimeout(() => void search(text), 150);
});

watch(picked, (id) => {
	const person = results.value.find((each) => each.id === id);
	if (!person) return;
	emit("pick", person);
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
</script>

<template>
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
			:placeholder="ADD_PEOPLE"
			:aria-label="ADD_PEOPLE"
			@update:open="onOpen"
		/>
	</div>
</template>
