<script setup lang="ts">
import { Avatar, Badge, Button, Dropdown, PageHeader, PageHeaderMobile, TabButtons, TextInput, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListHeaderCellSort, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref } from "vue";
import { admin, unwrap, type Person, type Settings } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import CreditBar from "../components/CreditBar.vue";
import CreditsDialog from "../components/CreditsDialog.vue";
import InviteDialog from "../components/InviteDialog.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import StatusBadge from "../components/StatusBadge.vue";
import EmptyState from "../../EmptyState.vue";
import { personActions } from "../lib/actions";
import { credits, lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { refreshCounts, settings } from "../store";

const people = ref<Person[]>([]);
/** Until the first answer, a failure shows in place of the list: an empty list would read as "no people yet". */
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind !== "loaded");

// Each load takes a number: an older answer that arrives late is dropped.
let asked = 0;

async function load() {
	const mine = ++asked;
	try {
		const data = await unwrap(admin.people.$get());
		if (mine !== asked) return;
		Object.assign(settings, data.settings);
		people.value = data.people;
		status.value = { kind: "loaded" };
	} catch (e) {
		if (mine !== asked) return;
		// A reload that fails keeps the list on screen, with a toast.
		if (status.value.kind === "loaded") toast.error((e as Error).message);
		else status.value = { kind: "error", message: (e as Error).message };
	}
}

function retry() {
	status.value = { kind: "loading" };
	void load();
}
void load();

const filter = ref("all");
// Each tab shows its count after the label, as metadata. No count while loading: "0" would read as a fact.
const filterTests: Record<string, (p: Person) => boolean> = {
	all: () => true,
	active: (p) => p.status === "active",
	invited: (p) => p.status === "invited",
	admins: (p) => p.role === "admin",
	banned: (p) => p.status === "banned",
};
const filters = [
	{ label: "All", value: "all" },
	{ label: "Active", value: "active" },
	{ label: "Invited", value: "invited" },
	{ label: "Admins", value: "admins" },
	{ label: "Banned", value: "banned" },
];
const filterCount = (value: string | number | undefined) => (loading.value ? null : people.value.filter(filterTests[String(value)]).length);

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
		.filter(filterTests[filter.value])
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
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">People</h1>
			<Button variant="solid" theme="gray" icon-left="lucide-user-plus" label="Invite people" class="ml-auto" @click="inviting = true" />
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<div v-if="status.kind !== 'error'" class="flex flex-col gap-2 pb-3 lg:flex-row lg:items-center">
			<TextInput v-model="search" type="search" placeholder="Search" aria-label="Search people" class="w-full lg:order-2 lg:ml-auto lg:w-60">
				<template #prefix>
					<span class="lucide-search size-4 text-ink-gray-5" aria-hidden="true" />
				</template>
			</TextInput>
			<div class="-mx-3 overflow-x-auto px-3 lg:order-1 lg:mx-0 lg:px-0">
				<TabButtons v-model="filter" :options="filters" class="w-max [&_[data-state=inactive]]:text-ink-gray-6">
					<template #suffix="{ button }">
						<span v-if="filterCount(button.value) != null" class="tabular-nums text-ink-gray-5">{{ filterCount(button.value) }}</span>
					</template>
				</TabButtons>
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
						<span class="truncate text-sm text-ink-gray-6">{{ item.email }}</span>
						<span class="truncate text-sm text-ink-gray-6">
							{{ item.status === "invited" ? "Not signed in yet" : `Active ${lastActive(item.lastActive)}` }}
						</span>
					</ListCell>
					<ListCell class="flex-col items-end gap-1 self-start">
						<template v-if="item.status === 'active'">
							<span class="text-sm tabular-nums">
								<span :class="item.today.used >= item.today.limit ? 'text-ink-red-6' : 'text-ink-gray-8'">{{ credits(item.today.used) }}</span>
								<span class="text-ink-gray-5"> / {{ credits(item.today.limit) }}</span>
							</span>
							<span class="text-xs text-ink-gray-5">today</span>
						</template>
						<StatusBadge v-else :status="item.status" />
					</ListCell>
				</ListRow>
			</ListRows>
		</List>

		<!-- Desktop: a table. A row is a link stretched under the row, so the menu can sit on top. -->
		<div v-else-if="status.kind !== 'error' && (loading || rows.length)" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
			<List :columns="['minmax(14rem,1fr)', '6rem', '10rem', '7rem', '8rem', '2.5rem']" :row-height="60" class="min-w-[52rem] list-row-px-3">
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
								<div class="truncate text-sm text-ink-gray-6">
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
							<span v-if="item.status === 'invited'" class="text-ink-gray-4">—</span>
							<template v-else>{{ credits(item.week) }}</template>
						</ListCell>
						<ListCell class="justify-end text-sm text-ink-gray-6">
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
		</div>

		<EmptyState v-if="status.kind === 'error'" icon="lucide-circle-alert" title="The people could not load" :body="status.message" alert>
			<Button label="Try again" @click="retry" />
		</EmptyState>

		<ListSkeleton v-else-if="loading" :rows="6" :avatar="isMobile ? 'lg' : 'md'" two-lines label="Loading people" />

		<EmptyState v-else-if="!rows.length" icon="lucide-users" :title="emptyText.title" :body="emptyText.body" />
	</div>

	<InviteDialog v-model:open="inviting" :taken="people.map((p) => p.email.toLowerCase())" @invited="invited" />
	<CreditsDialog v-model:open="creditsOpen" :person="creditsFor" @saved="load" />
</template>
