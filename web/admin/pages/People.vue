<script setup lang="ts">
import { Avatar, Badge, Button, Dropdown, PageHeader, PageHeaderMobile, TabButtons, TextInput, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListHeaderCellSort, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref } from "vue";
import { api, type Person, type Settings } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import CreditBar from "../components/CreditBar.vue";
import CreditsDialog from "../components/CreditsDialog.vue";
import InviteDialog from "../components/InviteDialog.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { personActions } from "../lib/actions";
import { credits, lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { refreshCounts, settings } from "../store";

const people = ref<Person[]>([]);
const loading = ref(true);

async function load() {
	try {
		const data = await api<{ people: Person[]; settings: Settings }>("/people");
		Object.assign(settings, data.settings);
		people.value = data.people;
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		loading.value = false;
	}
}
void load();

const filter = ref("all");
// A label with its count, such as "Active 12". No count while loading: "0" would read as a fact.
const counted = (label: string, test: (p: Person) => boolean) => (loading.value ? label : `${label} ${people.value.filter(test).length}`);
const filters = computed(() => [
	{ label: counted("All", () => true), value: "all" },
	{ label: counted("Active", (p) => p.status === "active"), value: "active" },
	{ label: counted("Invited", (p) => p.status === "invited"), value: "invited" },
	{ label: counted("Admins", (p) => p.role === "admin"), value: "admins" },
	{ label: counted("Banned", (p) => p.status === "banned"), value: "banned" },
]);

const search = ref("");

type SortKey = "week" | "lastActive";
const sortKey = ref<SortKey>("lastActive");
const direction = ref<"asc" | "desc">("desc");
function sortBy(key: SortKey) {
	if (sortKey.value === key) direction.value = direction.value === "asc" ? "desc" : "asc";
	else {
		sortKey.value = key;
		direction.value = "desc";
	}
}
const sortValue = (p: Person) => (sortKey.value === "week" ? p.week : p.lastActive ? Date.parse(p.lastActive) : 0);

const rows = computed(() => {
	const query = search.value.trim().toLowerCase();
	const factor = direction.value === "desc" ? -1 : 1;
	return people.value
		.filter((p) => {
			if (filter.value === "admins") return p.role === "admin";
			if (filter.value !== "all") return p.status === filter.value;
			return true;
		})
		.filter((p) => !query || `${p.name} ${p.email} ${p.note}`.toLowerCase().includes(query))
		.sort((a, b) => factor * (sortValue(a) - sortValue(b)));
});

const emptyText = computed(() => {
	if (search.value.trim()) return { title: "No one matches", body: "Try a name, an email or a note." };
	if (filter.value === "banned") return { title: "No one is banned", body: "Banned people show here." };
	if (filter.value === "invited") return { title: "No invites waiting", body: "Everyone you invited has signed in." };
	return { title: "No people yet", body: "Invite people to get started." };
});

const inviting = ref(false);
const creditsFor = ref<Person | null>(null);
const creditsOpen = ref(false);
function openCredits(person: Person) {
	creditsFor.value = person;
	creditsOpen.value = true;
}
const actionsFor = (person: Person) => personActions(person, { openCredits, changed: load });

function invited() {
	void load();
	void refreshCounts();
}
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="People">
		<template #prefix><AccountMenu compact /></template>
		<template #suffix>
			<Button variant="ghost" icon="lucide-user-plus" aria-label="Invite people" @click="inviting = true" />
		</template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<h1 class="text-2xl text-ink-gray-9">People</h1>
		<Button variant="solid" theme="gray" icon-left="lucide-user-plus" label="Invite people" class="ml-auto" @click="inviting = true" />
	</PageHeader>

	<div class="px-3 pb-16 pt-3 sm:px-5 md:pt-5">
		<div class="flex flex-col gap-2 pb-3 md:flex-row md:items-center">
			<TextInput v-model="search" type="search" placeholder="Search" aria-label="Search people" class="w-full md:order-2 md:ml-auto md:w-60">
				<template #prefix>
					<span class="lucide-search size-4 text-ink-gray-5" aria-hidden="true" />
				</template>
			</TextInput>
			<div class="-mx-3 overflow-x-auto px-3 md:order-1 md:mx-0 md:px-0">
				<TabButtons v-model="filter" :options="filters" class="w-max" />
			</div>
		</div>

		<!-- Phone: a feed. Tap a row for the person's page, where the actions are. -->
		<List v-if="isMobile" class="-mx-3 list-row-px-3">
			<ListRows :items="loading ? [] : rows" v-slot="{ item }">
				<ListRow :route="`/people/${encodeURIComponent(item.id)}`" class="py-3">
					<ListCell class="self-start pt-0.5"><Avatar :label="item.name" size="lg" /></ListCell>
					<ListCell class="flex-col items-stretch gap-0.5">
						<div class="flex items-center gap-1.5">
							<span class="truncate text-base text-ink-gray-8">{{ item.name }}</span>
							<Badge v-if="item.role === 'admin'" label="Admin" variant="outline" size="sm" />
						</div>
						<span class="truncate text-sm text-ink-gray-5">{{ item.email }}</span>
						<span class="truncate text-sm text-ink-gray-5">
							{{ item.status === "invited" ? "Not signed in yet" : `Active ${lastActive(item.lastActive)}` }}
						</span>
					</ListCell>
					<ListCell class="flex-col items-end gap-1 self-start">
						<template v-if="item.status === 'active'">
							<span class="text-sm tabular-nums" :class="item.today.used >= item.today.limit ? 'text-ink-red-5' : 'text-ink-gray-7'">
								{{ credits(item.today.used) }} / {{ credits(item.today.limit) }}
							</span>
							<span class="text-xs text-ink-gray-5">today</span>
						</template>
						<StatusBadge v-else :status="item.status" />
					</ListCell>
				</ListRow>
			</ListRows>
		</List>

		<!-- Desktop: a table. A row is a link stretched under the row, so the menu can sit on top. -->
		<List v-else :columns="['minmax(14rem,1fr)', '6rem', '10rem', '7rem', '8rem', '2.5rem']" :row-height="60" class="-mx-3 list-row-px-3">
			<ListHeader>
				<ListHeaderCell>Person</ListHeaderCell>
				<ListHeaderCell>Status</ListHeaderCell>
				<ListHeaderCell>Credits today</ListHeaderCell>
				<ListHeaderCellSort :direction="sortKey === 'week' ? direction : null" align="end" class="justify-end" @click="sortBy('week')">
					Last 7 days
				</ListHeaderCellSort>
				<ListHeaderCellSort
					:direction="sortKey === 'lastActive' ? direction : null"
					align="end"
					class="justify-end"
					@click="sortBy('lastActive')"
				>
					Last active
				</ListHeaderCellSort>
				<ListHeaderCell />
			</ListHeader>

			<ListRows :items="loading ? [] : rows" v-slot="{ item }">
				<ListRow class="rounded-4 hover:bg-surface-gray-2">
					<ListCell class="gap-3">
						<RouterLink :to="`/people/${encodeURIComponent(item.id)}`" class="absolute inset-0 rounded-4" :aria-label="item.name" />
						<Avatar :label="item.name" size="md" />
						<div class="min-w-0">
							<div class="flex items-center gap-1.5">
								<span class="truncate text-base text-ink-gray-8">{{ item.name }}</span>
								<Badge v-if="item.role === 'admin'" label="Admin" variant="outline" size="sm" />
							</div>
							<div class="truncate text-sm text-ink-gray-5">
								{{ item.email }}<template v-if="item.note"> · {{ item.note }}</template>
							</div>
						</div>
					</ListCell>
					<ListCell><StatusBadge :status="item.status" /></ListCell>
					<ListCell>
						<CreditBar v-if="item.status === 'active'" :used="item.today.used" :limit="item.today.limit" />
						<span v-else class="text-sm text-ink-gray-4">—</span>
					</ListCell>
					<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">
						{{ item.status === "invited" ? "—" : credits(item.week) }}
					</ListCell>
					<ListCell class="justify-end text-sm text-ink-gray-5">
						{{ item.status === "invited" ? "Not signed in" : lastActive(item.lastActive) }}
					</ListCell>
					<ListCell class="justify-end">
						<Dropdown :options="actionsFor(item)">
							<Button variant="ghost" icon="lucide-ellipsis" class="relative" :aria-label="`Actions for ${item.name}`" />
						</Dropdown>
					</ListCell>
				</ListRow>
			</ListRows>
		</List>

		<ListSkeleton v-if="loading" :rows="6" :avatar="isMobile ? 'lg' : 'md'" two-lines label="Loading people" />

		<div v-else-if="!rows.length" class="flex flex-col items-center gap-3 py-16 text-center">
			<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
				<span class="lucide-users size-6" aria-hidden="true" />
			</div>
			<p class="text-base text-ink-gray-7">{{ emptyText.title }}</p>
			<p class="text-sm text-ink-gray-5">{{ emptyText.body }}</p>
		</div>
	</div>

	<InviteDialog v-model:open="inviting" :taken="people.map((p) => p.email.toLowerCase())" @invited="invited" />
	<CreditsDialog v-model:open="creditsOpen" :person="creditsFor" @saved="load" />
</template>
