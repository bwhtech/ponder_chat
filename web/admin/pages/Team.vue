<script setup lang="ts">
import { Avatar, Badge, Breadcrumbs, Button, Dropdown, PageHeader, PageHeaderBackButton, PageHeaderMobile, Select, Skeleton, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { displayName } from "../../../shared/display-name";
import { admin, ApiError, unwrap, type PersonFound, type TeamDetail, type TeamMember, type TeamRole } from "../api";
import ListSkeleton from "../components/ListSkeleton.vue";
import PersonSearch from "../components/PersonSearch.vue";
import TeamFormDialog from "../components/TeamFormDialog.vue";
import EmptyState from "../../EmptyState.vue";
import { when } from "../../dates";
import { count } from "../../numbers";
import { isMobile } from "../lib/viewport";

/**
 * One team (server/teams/Teams.ts): its name and description, which org admins edit, and
 * its people with their roles. "Add people" adds a person at once, with the role picked.
 * Each change answers the team as it is now, and the page shows that answer.
 */
const props = defineProps<{ id: string }>();

type PageState = { kind: "loading" } | { kind: "loaded"; team: TeamDetail } | { kind: "missing" } | { kind: "error"; message: string };
const state = ref<PageState>({ kind: "loading" });
const team = computed(() => (state.value.kind === "loaded" ? state.value.team : null));

// Declared before the watch below, which calls load() at once.
let asked = 0;

watch(
	() => props.id,
	() => {
		state.value = { kind: "loading" };
		void load();
	},
	{ immediate: true },
);

async function load() {
	const mine = ++asked;
	try {
		const data = await unwrap(admin.teams[":id"].$get({ param: { id: encodeURIComponent(props.id) } }));
		if (mine === asked) state.value = { kind: "loaded", team: data.team };
	} catch (e) {
		if (mine !== asked) return;
		if (e instanceof ApiError && e.status === 404) state.value = { kind: "missing" };
		else if (state.value.kind === "loaded") toast.error((e as Error).message);
		else state.value = { kind: "error", message: (e as Error).message };
	}
}

function retry() {
	state.value = { kind: "loading" };
	void load();
}

/** Shows the team as a change left it. A newer load in flight is dropped. */
function show(changed: TeamDetail) {
	asked++;
	state.value = { kind: "loaded", team: changed };
}

const ROLES = [
	{ label: "Member", value: "member" },
	{ label: "Team admin", value: "admin" },
];
const newRole = ref<TeamRole>("member");
const memberIds = computed(() => team.value?.members.map((member) => member.id) ?? []);
const summary = computed(() => {
	const members = team.value?.members ?? [];
	const admins = members.filter((member) => member.role === "admin").length;
	return `${count(members.length)} ${members.length === 1 ? "member" : "members"} · ${count(admins)} ${admins === 1 ? "team admin" : "team admins"}`;
});

const nameOf = (person: { name: string; email: string }) => displayName(person.name, person.email);
const param = (member: { id: string }) => ({ id: encodeURIComponent(props.id), userId: encodeURIComponent(member.id) });

async function setRole(person: { id: string; name: string; email: string }, role: TeamRole, added: boolean) {
	try {
		show((await unwrap(admin.teams[":id"].members[":userId"].$put({ param: param(person), json: { role } }))).team);
		const as = role === "admin" ? "a team admin" : "a member";
		toast.success(added ? `Added ${nameOf(person)} as ${as}` : `${nameOf(person)} is now ${as}`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

async function remove(member: TeamMember) {
	try {
		show((await unwrap(admin.teams[":id"].members[":userId"].$delete({ param: param(member) }))).team);
		toast.success(`Removed ${nameOf(member)} from the team`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

const add = (person: PersonFound) => void setRole(person, newRole.value, true);

const actionsFor = (member: TeamMember) => [
	member.role === "admin"
		? { label: "Make member", icon: "lucide-user-round", onClick: () => void setRole(member, "member", false) }
		: { label: "Make team admin", icon: "lucide-shield-check", onClick: () => void setRole(member, "admin", false) },
	{ label: "Remove from team", icon: "lucide-user-round-minus", theme: "red" as const, onClick: () => void remove(member) },
];

const editing = ref(false);
</script>

<template>
	<template v-if="team">
		<PageHeaderMobile v-if="isMobile" :title="team.name">
			<template #prefix><PageHeaderBackButton :fallback-route="{ path: '/teams' }" /></template>
			<template #suffix>
				<Button v-if="team.canOrganise && !team.archived" variant="ghost" icon="lucide-pencil" aria-label="Edit team" @click="editing = true" />
			</template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<Breadcrumbs class="-ml-0.5" :items="[{ label: 'Teams', route: '/teams' }, { label: team.name }]" />
			<div class="ml-auto flex items-center gap-2">
				<Button v-if="team.canOrganise && !team.archived" label="Edit" icon-left="lucide-pencil" @click="editing = true" />
			</div>
		</PageHeader>

		<div class="w-full max-w-3xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
			<div class="space-y-1">
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<h1 class="min-w-0 break-words text-xl-semibold text-ink-gray-9 md:text-2xl-semibold">{{ team.name }}</h1>
					<Badge v-if="team.archived" label="Archived" variant="subtle" />
				</div>
				<p v-if="team.description" class="whitespace-pre-line break-words text-p-base text-ink-gray-6">{{ team.description }}</p>
				<p class="text-sm tabular-nums text-ink-gray-6">{{ summary }}</p>
			</div>

			<section v-if="team.canChangePeople" class="space-y-3" aria-labelledby="add-people">
				<h2 id="add-people" class="text-base-semibold text-ink-gray-9">Add people</h2>
				<div class="flex flex-col gap-2 sm:flex-row">
					<div class="min-w-0 flex-1">
						<PersonSearch :exclude="memberIds" placeholder="Add people by name or email" @pick="add" />
					</div>
					<Select v-model="newRole" :options="ROLES" aria-label="Role for the people you add" class="sm:w-36" />
				</div>
			</section>

			<section class="space-y-3" aria-labelledby="members">
				<h2 id="members" class="text-base-semibold text-ink-gray-9">Members</h2>
				<ul v-if="team.members.length" class="divide-y divide-outline-gray-1">
					<li v-for="member in team.members" :key="member.id" class="flex items-center gap-3 py-2.5" :data-member="member.email">
						<Avatar :label="nameOf(member)" size="lg" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="truncate text-base text-ink-gray-8">{{ nameOf(member) }}</span>
								<Badge v-if="member.role === 'admin'" label="Team admin" variant="outline" size="sm" />
							</div>
							<p class="truncate text-sm text-ink-gray-6">{{ member.email }}</p>
						</div>
						<Dropdown v-if="team.canChangePeople" :options="actionsFor(member)">
							<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for ${nameOf(member)}`" />
						</Dropdown>
					</li>
				</ul>
				<EmptyState v-else icon="lucide-users-round" title="No one in this team" body="Add people above. A team needs a team admin to manage it." />
			</section>

			<section v-if="team.invites.length" class="space-y-3" aria-labelledby="invites">
				<h2 id="invites" class="text-base-semibold text-ink-gray-9">Invited</h2>
				<ul class="divide-y divide-outline-gray-1">
					<li v-for="invite in team.invites" :key="invite.email" class="flex items-center gap-3 py-2.5">
						<Avatar :label="invite.email" size="lg" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1.5">
								<span class="truncate text-base text-ink-gray-8">{{ invite.email }}</span>
								<Badge v-if="invite.role === 'admin'" label="Team admin" variant="outline" size="sm" />
							</div>
							<p class="truncate text-sm text-ink-gray-6">Invited by {{ invite.invitedBy }} · {{ when(invite.createdAt) }}</p>
						</div>
					</li>
				</ul>
			</section>
		</div>

		<TeamFormDialog v-model:open="editing" :team="team" @saved="show" />
	</template>

	<!-- Missing, error and loading keep the page's own frame. -->
	<template v-else>
		<PageHeaderMobile v-if="isMobile" :title="state.kind === 'missing' ? 'Not found' : state.kind === 'error' ? 'Could not load' : ''">
			<template #prefix><PageHeaderBackButton :fallback-route="{ path: '/teams' }" /></template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<!-- Loading: "Teams" stays a parent link, and a bar stands where the name lands. Same classes as frappe-ui's Breadcrumbs. -->
			<nav v-if="state.kind === 'loading'" aria-label="Breadcrumb" class="-ml-0.5 flex items-center leading-tighter">
				<RouterLink to="/teams" class="rounded-4 px-0.5 py-1 text-lg-medium leading-tighter text-ink-gray-5 hover:text-ink-gray-7">Teams</RouterLink>
				<span class="mx-0.5 text-base text-ink-gray-4" aria-hidden="true">/</span>
				<span class="flex px-0.5 py-1"><Skeleton class="h-3.5 w-16 rounded-4" /></span>
			</nav>
			<Breadcrumbs v-else class="-ml-0.5" :items="[{ label: 'Teams', route: '/teams' }, { label: state.kind === 'missing' ? 'Not found' : 'Could not load' }]" />
		</PageHeader>

		<div v-if="state.kind === 'missing' || state.kind === 'error'" class="px-3 pt-4 sm:px-5 md:pt-6">
			<EmptyState v-if="state.kind === 'missing'" icon="lucide-users-round" title="No such team" body="It may have been deleted.">
				<Button label="All teams" route="/teams" />
			</EmptyState>
			<EmptyState v-else icon="lucide-circle-alert" title="This team could not load" :body="state.message" alert>
				<Button label="Try again" @click="retry" />
			</EmptyState>
		</div>
		<div v-else class="w-full max-w-3xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6" aria-busy="true" aria-label="Loading this team">
			<div class="space-y-1">
				<div class="flex h-[1lh] items-center text-xl-semibold md:text-2xl-semibold"><Skeleton class="h-5 w-40 max-w-full rounded-4" /></div>
				<!-- Most teams have a description: a line stands for it. -->
				<div class="flex h-[1lh] items-center text-p-base"><Skeleton class="h-3.5 w-72 max-w-full rounded-4" /></div>
				<div class="flex h-[1lh] items-center text-sm"><Skeleton class="h-3 w-36 rounded-4" /></div>
			</div>
			<section class="space-y-3">
				<h2 class="text-base-semibold text-ink-gray-9">Add people</h2>
				<div class="flex flex-col gap-2 sm:flex-row">
					<Skeleton class="h-7 flex-1 rounded-4" />
					<Skeleton class="h-7 rounded-4 sm:w-36" />
				</div>
			</section>
			<section class="space-y-3">
				<h2 class="text-base-semibold text-ink-gray-9">Members</h2>
				<ListSkeleton :rows="3" avatar="lg" two-lines label="Loading the members" />
			</section>
		</div>
	</template>
</template>
