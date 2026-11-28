<script setup lang="ts">
import { Badge, Button, PageHeader, PageHeaderMobile, TextInput, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref } from "vue";
import { admin, unwrap, type TeamSummary } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import TeamFormDialog from "../components/TeamFormDialog.vue";
import EmptyState from "../../EmptyState.vue";
import { count } from "../../numbers";
import { isMobile } from "../lib/viewport";
import { scope } from "../store";

/**
 * Teams (server/teams/Teams.ts): named groups of people, such as HR. Org admins see every
 * team, archived ones last, and make new ones. Team admins see the active teams they admin,
 * and this is their first page. A row opens the team's page.
 */
const orgAdmin = computed(() => scope.value === "org");
const teams = ref<TeamSummary[]>([]);
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind !== "loaded");

let asked = 0;
async function load() {
	const mine = ++asked;
	try {
		const data = await unwrap(admin.teams.$get());
		if (mine !== asked) return;
		teams.value = data.teams;
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

const search = ref("");
const rows = computed(() => {
	const query = search.value.trim().toLowerCase();
	return teams.value.filter((team) => !query || team.name.toLowerCase().includes(query) || team.description.toLowerCase().includes(query));
});

const emptyText = computed(() =>
	teams.value.length
		? { title: "No teams match", body: "Try another search." }
		: orgAdmin.value
			? { title: "No teams yet", body: "Make a team, such as HR, and name its first team admin. Team admins add the rest of the team." }
			: { title: "No teams to manage", body: "You are not a team admin of an active team now." },
);

/** "12 members · 2 admins", or with pending invites. */
function counts(team: TeamSummary) {
	const parts = [`${count(team.memberCount)} ${team.memberCount === 1 ? "member" : "members"}`, `${count(team.adminCount)} ${team.adminCount === 1 ? "admin" : "admins"}`];
	if (team.inviteCount) parts.push(`${count(team.inviteCount)} invited`);
	return parts.join(" · ");
}

const creating = ref(false);
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Teams">
		<template #prefix><AccountMenu compact /></template>
		<template v-if="orgAdmin" #suffix><Button variant="ghost" icon="lucide-plus" aria-label="New team" @click="creating = true" /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">Teams</h1>
			<Button v-if="orgAdmin" variant="solid" theme="gray" icon-left="lucide-plus" label="New team" class="ml-auto" @click="creating = true" />
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<p class="max-w-[640px] pb-4 text-p-sm text-ink-gray-6">
			<template v-if="orgAdmin">A team is a group of people, such as HR. Its team admins add and remove its people. Teams give no access on their own.</template>
			<template v-else>The teams you manage. Add people, invite new ones by email, change roles and remove people.</template>
		</p>

		<div v-if="teams.length" class="flex pb-3">
			<TextInput v-model="search" type="search" placeholder="Search" aria-label="Search teams" class="w-full md:ml-auto md:w-60">
				<template #prefix><span class="lucide-search size-4 text-ink-gray-5" aria-hidden="true" /></template>
			</TextInput>
		</div>

		<!-- Phone: a feed. Tap a row for the team's page. -->
		<List v-if="isMobile" class="-mx-3 list-row-px-3">
			<ListRows :items="loading ? [] : rows" v-slot="{ item }">
				<ListRow :route="`/teams/${encodeURIComponent(item.id)}`" class="py-3">
					<ListCell class="flex-col items-stretch gap-0.5">
						<div class="flex items-center gap-1.5">
							<span class="truncate text-base" :class="item.archived ? 'text-ink-gray-6' : 'text-ink-gray-8'">{{ item.name }}</span>
							<Badge v-if="item.archived" label="Archived" variant="subtle" size="sm" />
						</div>
						<span v-if="item.description" class="line-clamp-2 text-p-sm text-ink-gray-6">{{ item.description }}</span>
						<span class="truncate text-sm tabular-nums text-ink-gray-6">{{ counts(item) }}</span>
					</ListCell>
				</ListRow>
			</ListRows>
		</List>

		<!-- Desktop: a table. A row is a link stretched under the row. -->
		<div v-else-if="status.kind !== 'error' && (loading || rows.length)" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
			<List :columns="['minmax(14rem,1fr)', '7rem', '7rem', '7rem']" :row-height="60" class="min-w-[40rem] list-row-px-3">
				<ListHeader>
					<ListHeaderCell>Team</ListHeaderCell>
					<ListHeaderCell class="justify-end">Members</ListHeaderCell>
					<ListHeaderCell class="justify-end">Admins</ListHeaderCell>
					<ListHeaderCell class="justify-end">Invited</ListHeaderCell>
				</ListHeader>
				<ListRows :items="loading ? [] : rows" v-slot="{ item }">
					<ListRow class="rounded-4 hover:bg-surface-gray-2" :data-team="item.name">
						<ListCell>
							<RouterLink :to="`/teams/${encodeURIComponent(item.id)}`" class="absolute inset-0 rounded-4" :aria-label="item.name" />
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<span class="truncate text-base" :class="item.archived ? 'text-ink-gray-6' : 'text-ink-gray-8'">{{ item.name }}</span>
									<Badge v-if="item.archived" label="Archived" variant="subtle" size="sm" />
								</div>
								<p v-if="item.description" class="mt-0.5 truncate text-sm text-ink-gray-6">{{ item.description }}</p>
							</div>
						</ListCell>
						<ListCell class="justify-end text-sm tabular-nums text-ink-gray-8">{{ count(item.memberCount) }}</ListCell>
						<ListCell class="justify-end text-sm tabular-nums" :class="item.adminCount ? 'text-ink-gray-8' : 'text-ink-amber-6'">{{ count(item.adminCount) }}</ListCell>
						<ListCell class="justify-end text-sm tabular-nums">
							<span v-if="item.inviteCount" class="text-ink-gray-8">{{ count(item.inviteCount) }}</span>
							<span v-else class="text-ink-gray-4">—</span>
						</ListCell>
					</ListRow>
				</ListRows>
			</List>
		</div>

		<EmptyState v-if="status.kind === 'error'" icon="lucide-circle-alert" title="The teams could not load" :body="status.message" alert>
			<Button label="Try again" @click="retry" />
		</EmptyState>

		<ListSkeleton v-else-if="loading" :rows="4" :avatar="false" two-lines label="Loading teams" />

		<EmptyState v-else-if="!rows.length" icon="lucide-users-round" :title="emptyText.title" :body="emptyText.body">
			<Button v-if="!teams.length && orgAdmin" variant="solid" theme="gray" icon-left="lucide-plus" label="New team" @click="creating = true" />
		</EmptyState>
	</div>

	<TeamFormDialog v-model:open="creating" />
</template>
