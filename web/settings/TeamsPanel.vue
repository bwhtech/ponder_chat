<script setup lang="ts">
import { Avatar, Badge, Button } from "frappe-ui";
import { onMounted, ref } from "vue";
import { displayName } from "../../shared/display-name";
import { client, unwrap, type Answer } from "../api";
import EmptyState from "../EmptyState.vue";
import PanelBody from "./PanelBody.vue";
import PanelHeader from "./PanelHeader.vue";
import TeamRowsSkeleton from "./TeamRowsSkeleton.vue";

/**
 * Settings, Teams: the person's active teams with their members (GET /api/teams/mine), read
 * only. A team they admin has Manage, to its page in /admin, in a new tab.
 */
type MyTeam = Answer<typeof client.api.teams.mine.$get>["teams"][number];

const teams = ref<MyTeam[]>();
const loadError = ref("");

onMounted(load);

async function load() {
	loadError.value = "";
	try {
		teams.value = (await unwrap(client.api.teams.mine.$get(), "Your teams could not load.")).teams;
	} catch (error) {
		loadError.value = error instanceof Error ? error.message : String(error);
	}
}

const nameOf = (person: { name: string; email: string }) => displayName(person.name, person.email);
const manageLink = (team: MyTeam) => `/admin/teams/${encodeURIComponent(team.id)}`;
</script>

<template>
	<PanelHeader title="Teams" />
	<PanelBody>
		<div class="pt-5">
			<EmptyState v-if="loadError" icon="lucide-circle-alert" title="Your teams could not load" :body="loadError" alert>
				<Button label="Try again" @click="load" />
			</EmptyState>
			<TeamRowsSkeleton v-else-if="!teams" />
			<EmptyState
				v-else-if="teams.length === 0"
				icon="lucide-users-round"
				title="You're in no team yet"
				body="An admin or a team admin adds you to a team. Workspaces shared with your teams then show in your list."
			/>
			<div v-else class="space-y-4">
				<section v-for="team in teams" :key="team.id" class="rounded-6 border border-outline-gray-2" :aria-label="team.name" :data-team="team.name">
					<div class="flex items-start gap-3 px-3 pt-3">
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<h3 class="min-w-0 break-words text-base-semibold text-ink-gray-9">{{ team.name }}</h3>
								<Badge v-if="team.role === 'admin'" label="Team admin" variant="outline" size="sm" />
							</div>
							<p v-if="team.description" class="whitespace-pre-line break-words text-p-sm text-ink-gray-6">{{ team.description }}</p>
						</div>
						<Button
							v-if="team.role === 'admin'"
							class="touch-target -mt-0.5 shrink-0"
							label="Manage"
							icon-right="lucide-arrow-up-right"
							:href="manageLink(team)"
						/>
					</div>
					<ul class="divide-y divide-outline-gray-1 px-3 pb-1 pt-2" :aria-label="`Members of ${team.name}`">
						<li v-for="member in team.members" :key="member.id" class="flex items-center gap-3 py-2.5" :data-member="member.email">
							<Avatar :label="nameOf(member)" size="lg" />
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-1.5">
									<span class="truncate text-base text-ink-gray-8">{{ nameOf(member) }}</span>
									<Badge v-if="member.role === 'admin'" label="Team admin" variant="outline" size="sm" />
								</div>
								<p class="truncate text-sm text-ink-gray-6">{{ member.email }}</p>
							</div>
						</li>
					</ul>
				</section>
			</div>
		</div>
	</PanelBody>
</template>
