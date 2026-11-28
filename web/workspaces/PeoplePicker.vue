<script setup lang="ts">
import { displayName } from "../../shared/display-name";
import { Combobox } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { plural } from "../numbers";
import { ADD_PEOPLE } from "./dialogs";
import { searchPeople, searchTeams, type Person, type TeamMatch } from "./store";

/**
 * Share's "Add people or teams" field (ShareDialog.vue): it searches teams by name and people
 * by name or email, and a team or a person picked from it is added at once (`pickTeam`,
 * `pick`). The search asks the server (GET /api/teams, GET /api/people), so the Combobox does
 * not filter again. People and teams already in the workspace (`exclude`, `excludeTeams`) are
 * not offered. Teams come first: there are few, and one adds many people.
 */
const props = defineProps<{ exclude: string[]; excludeTeams: string[] }>();
const emit = defineEmits<{ pick: [person: Person]; pickTeam: [team: TeamMatch] }>();
// Tailwind's sm.
const wide = matchMedia("(min-width: 640px)").matches;
/** A team's value in the Combobox, apart from people's ids. */
const TEAM = "team:";

const query = ref("");
const results = ref<{ people: readonly Person[]; teams: readonly TeamMatch[] }>({ people: [], teams: [] });
const searching = ref(false);
const searchError = ref("");
const picked = ref<string | null>(null);
// Each search takes a number: a slower answer to an older query is dropped.
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const options = computed(() => {
	const teams = results.value.teams
		.filter((team) => !props.excludeTeams.includes(team.id))
		.map((team) => ({ label: team.name, value: TEAM + team.id, icon: "lucide-users", description: plural(team.memberCount, "member") }));
	const people = results.value.people
		.filter((person) => !props.exclude.includes(person.id))
		.map((person) => ({ label: displayName(person.name, person.email), value: person.id, description: person.email }));
	return [
		{ group: "Teams", options: teams },
		{ group: "People", options: people },
	].filter((group) => group.options.length > 0);
});
const found = computed(() => options.value.length > 0);

watch(query, (text) => {
	clearTimeout(timer);
	timer = setTimeout(() => void search(text), 150);
});

watch(picked, (value) => {
	if (value === null) return;
	const team = value.startsWith(TEAM) ? results.value.teams.find((each) => TEAM + each.id === value) : undefined;
	const person = team ? undefined : results.value.people.find((each) => each.id === value);
	if (team) emit("pickTeam", team);
	else if (person) emit("pick", person);
	else return;
	picked.value = null;
	query.value = "";
});

async function search(text: string) {
	const mine = ++asked;
	searching.value = true;
	try {
		const [people, teams] = await Promise.all([searchPeople(text.trim()), searchTeams(text.trim())]);
		if (mine === asked) [results.value, searchError.value] = [{ people, teams }, ""];
	} catch (error) {
		if (mine === asked) searchError.value = (error as Error).message;
	} finally {
		if (mine === asked) searching.value = false;
	}
}

/** A new search each time the list opens, starting from the first teams and people. */
function onOpen(open: boolean) {
	if (!open) return;
	query.value = "";
	void search("");
}
</script>

<template>
	<!-- The dialog opens in the search on a wider screen (frappe-ui's Dialog focuses [autofocus]).
	     On a phone the keyboard would cover the list, so it does not. -->
	<div :autofocus="wide">
		<Combobox
			v-model="picked"
			class="w-full"
			v-model:query="query"
			:options="options"
			:filterable="false"
			:loading="searching && !found"
			:empty-text="searchError || (query.trim() ? 'Nobody matches' : 'Nobody else to add')"
			:placeholder="ADD_PEOPLE"
			:aria-label="ADD_PEOPLE"
			@update:open="onOpen"
		/>
	</div>
</template>
