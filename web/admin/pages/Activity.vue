<script setup lang="ts">
import { Avatar, Breadcrumbs, Button, PageHeader, PageHeaderBackButton, PageHeaderMobile, Tooltip, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { admin, unwrap, type Activity, type ActivityPage } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import EmptyState from "../../EmptyState.vue";
import { clockTime, fullDate } from "../../dates";
import { describe } from "../lib/activity";
import { lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";

/**
 * The admin activity log (server/admin/AdminEvents.ts), newest first: each change an admin
 * made, from /admin or straight through Better Auth. Read only: no one can change or
 * delete an event. ?person=<id or email> shows the events done by or to one person.
 */
const route = useRoute();
const person = computed(() => (typeof route.query.person === "string" ? route.query.person : ""));

type Row = Activity & { text: string; details: string };
const rows = ref<Row[]>([]);
const next = ref<number | null>(null);
const filtered = ref<ActivityPage["person"]>(null);
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind === "loading");
const loadingMore = ref(false);

// Each first load takes a number: an older answer that arrives late, such as for another person, is dropped.
let asked = 0;

async function load() {
	const mine = ++asked;
	// Start empty: a load for another person must not show the last person's rows, or page on with their cursor.
	status.value = { kind: "loading" };
	filtered.value = null;
	rows.value = [];
	next.value = null;
	try {
		const page = await fetchPage();
		if (mine !== asked) return;
		rows.value = page.events.map(toRow);
		next.value = page.next;
		filtered.value = page.person;
		status.value = { kind: "loaded" };
	} catch (e) {
		if (mine === asked) status.value = { kind: "error", message: (e as Error).message };
	}
}

/** The next page goes under the rows. A failure keeps the rows, with a toast. */
async function loadMore() {
	const mine = asked;
	loadingMore.value = true;
	try {
		const page = await fetchPage(next.value);
		if (mine !== asked) return;
		rows.value.push(...page.events.map(toRow));
		next.value = page.next;
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		loadingMore.value = false;
	}
}

function fetchPage(before?: number | null) {
	return unwrap(admin.activity.$get({ query: { person: person.value || undefined, before: before ? String(before) : undefined } }));
}

function toRow(event: Activity): Row {
	const { text, details } = describe(event);
	return { ...event, text, details: details.join(" · ") };
}

watch(person, load, { immediate: true });

const filterLink = (id: string) => ({ path: "/activity", query: { person: id } });
const exactTime = (iso: string) => `${fullDate(iso)}, ${clockTime(iso)}`;
const title = computed(() => (person.value ? (filtered.value?.name ?? "Activity") : "Activity"));
const emptyText = computed(() =>
	person.value
		? { title: "No activity", body: "No admin has changed anything for this person, and they have made no admin changes." }
		: { title: "No activity yet", body: "Changes that admins make show here: credits, invites, roles, bans, emails, settings and skills." },
);
</script>

<template>
	<PageHeaderMobile v-if="isMobile" :title="title">
		<template #prefix>
			<PageHeaderBackButton v-if="person" :fallback-route="{ path: '/activity' }" />
			<AccountMenu v-else compact />
		</template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<Breadcrumbs v-if="person" class="-ml-0.5" :items="[{ label: 'Activity', route: '/activity' }, { label: filtered?.name ?? '…' }]" />
			<h1 v-else class="text-lg-semibold text-ink-gray-9">Activity</h1>
			<Button v-if="person && filtered?.email" class="ml-auto" label="Open profile" icon-left="lucide-user" :route="`/people/${encodeURIComponent(filtered.id)}`" />
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<section class="space-y-3">
			<!-- Phone: one event a row, its details and who did it under it. -->
			<List v-if="isMobile && rows.length && !loading" :columns="['minmax(0,1fr)']" class="-mx-3 list-row-px-3">
				<ListRows :items="rows" v-slot="{ item }">
					<ListRow class="py-3">
						<ListCell class="flex-col items-stretch gap-0.5">
							<div class="flex items-baseline justify-between gap-2">
								<span class="truncate text-base text-ink-gray-8">
									{{ item.text }}<template v-if="item.target"> · <RouterLink :to="filterLink(item.target.id)">{{ item.target.name }}</RouterLink></template>
								</span>
								<span class="shrink-0 text-sm text-ink-gray-6">{{ lastActive(item.at) }}</span>
							</div>
							<span v-if="item.details" class="truncate text-sm text-ink-gray-6">{{ item.details }}</span>
							<span class="truncate text-xs text-ink-gray-5">By {{ item.actor.name }}</span>
						</ListCell>
					</ListRow>
				</ListRows>
			</List>

			<!-- Wider screens: the column names stay while the rows load, as on Requests. -->
			<div v-else-if="!isMobile && (loading || rows.length)" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
				<List :columns="['minmax(0,1fr)', '12rem', '11rem', '8rem']" :row-height="52" class="min-w-[50rem] list-row-px-3">
					<ListHeader>
						<ListHeaderCell>What</ListHeaderCell>
						<ListHeaderCell>Person</ListHeaderCell>
						<ListHeaderCell>Admin</ListHeaderCell>
						<ListHeaderCell>When</ListHeaderCell>
					</ListHeader>
					<ListRows :items="loading ? [] : rows" v-slot="{ item }">
						<ListRow>
							<ListCell>
								<div class="min-w-0">
									<div class="truncate text-base text-ink-gray-8">{{ item.text }}</div>
									<div v-if="item.details" class="truncate text-sm text-ink-gray-6" :title="item.details">{{ item.details }}</div>
								</div>
							</ListCell>
							<ListCell class="gap-2.5">
								<template v-if="item.target">
									<Avatar :label="item.target.name" size="sm" />
									<RouterLink :to="filterLink(item.target.id)" class="truncate text-sm text-ink-gray-8" :title="item.target.email">{{ item.target.name }}</RouterLink>
								</template>
								<span v-else class="text-sm text-ink-gray-4">—</span>
							</ListCell>
							<ListCell>
								<RouterLink :to="filterLink(item.actor.id)" class="truncate text-sm text-ink-gray-7" :title="item.actor.email">{{ item.actor.name }}</RouterLink>
							</ListCell>
							<ListCell>
								<Tooltip :text="exactTime(item.at)">
									<span class="truncate text-sm text-ink-gray-6">{{ lastActive(item.at) }}</span>
								</Tooltip>
							</ListCell>
						</ListRow>
					</ListRows>
				</List>
			</div>

			<ListSkeleton v-if="loading" :rows="6" :avatar="false" two-lines label="Loading activity" />
			<EmptyState v-else-if="status.kind === 'error'" icon="lucide-circle-alert" title="The activity could not load" :body="status.message" alert>
				<Button label="Try again" @click="load" />
			</EmptyState>
			<EmptyState v-else-if="!rows.length" icon="lucide-history" :title="emptyText.title" :body="emptyText.body" />

			<div v-if="next && !loading" class="flex justify-center pt-2">
				<Button label="Load more" :loading="loadingMore" @click="loadMore" />
			</div>
		</section>
	</div>
</template>
