<script setup lang="ts">
import { Combobox, debounce } from "frappe-ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { displayName } from "../../../shared/display-name";
import { client } from "../../api";
import { unwrap, type PersonFound } from "../api";

/**
 * A search of people by name or email (GET /api/people), as Share's picker in the chat
 * (web/workspaces/PeoplePicker.vue). Banned people are not found. The person picked is
 * emitted and the field empties again. People in `exclude` are not offered.
 */
const props = defineProps<{ exclude: string[]; placeholder: string }>();
const emit = defineEmits<{ pick: [person: PersonFound] }>();

const query = ref("");
const results = ref<readonly PersonFound[]>([]);
const searching = ref(false);
const searchError = ref("");
const picked = ref<string | null>(null);
// Each search takes a number: a slower answer to an older query is dropped.
let asked = 0;
const searchSoon = debounce((text: string) => void search(text), 150);
onUnmounted(() => searchSoon.cancel());

const options = computed(() =>
	results.value
		.filter((person) => !props.exclude.includes(person.id))
		.map((person) => ({ label: displayName(person.name, person.email), value: person.id, description: person.email })),
);

watch(query, (text) => searchSoon(text));

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
		const found = (await unwrap(client.api.people.$get({ query: { q: text.trim() } }), "People could not load.")).people;
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
	<Combobox
		v-model="picked"
		class="w-full"
		v-model:query="query"
		:options="options"
		:filterable="false"
		:loading="searching && !options.length"
		:empty-text="searchError || (query.trim() ? 'Nobody matches' : 'Nobody else to add')"
		:placeholder="placeholder"
		:aria-label="placeholder"
		@update:open="onOpen"
	/>
</template>
