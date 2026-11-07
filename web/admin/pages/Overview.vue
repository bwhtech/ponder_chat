<script setup lang="ts">
import { Alert, Avatar, Button, PageHeader, PageHeaderMobile, TabButtons } from "frappe-ui";
import { BarChart, DonutChart, LineChart, NumberCard } from "frappe-ui/charts";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type Overview } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import CreditBar from "../components/CreditBar.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import { credits, dollars, shortDay } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { counts, settings } from "../store";

const router = useRouter();
const range = ref("14");
const ranges = [
	{ label: "7 days", value: "7" },
	{ label: "14 days", value: "14" },
	{ label: "30 days", value: "30" },
];

const data = ref<Overview | null>(null);
/** Why the numbers for this range could not load; the page then offers Retry in their place. */
const loadError = ref("");
const loading = computed(() => !data.value);

// Each load takes a number: a slow answer for a range no longer picked is dropped.
// Declared before the watch below, which calls load() at once.
let asked = 0;

// A new range keeps the old numbers on screen until the new ones arrive.
watch(range, load, { immediate: true });

async function load() {
	const mine = ++asked;
	loadError.value = "";
	try {
		const overview = await api<Overview>(`/overview?days=${range.value}`);
		if (mine !== asked) return;
		settings.creditsPerUsd = overview.creditsPerUsd;
		data.value = overview;
	} catch (e) {
		if (mine !== asked) return;
		// The numbers on screen are for another range now: they go, and the error takes their place.
		data.value = null;
		loadError.value = (e as Error).message;
	}
}

const daily = computed(() =>
	(data.value?.days ?? []).map((day) => ({ day: shortDay(day.date), Credits: day.credits, "Active people": day.active })),
);
const rangeCredits = computed(() => daily.value.reduce((total, day) => total + day.Credits, 0));
const now = computed(() => data.value?.today ?? { active: 0, replies: 0, credits: 0, outOfCredits: 0 });
const yesterday = computed(() => data.value?.yesterday ?? { active: 0, replies: 0 });
const top = computed(() => data.value?.people ?? []);
const pending = computed(() => counts.pendingRequests);

function openRequests() {
	void router.push("/requests");
}
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Overview">
		<template #prefix><AccountMenu compact /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<h1 class="text-2xl text-ink-gray-9">Overview</h1>
		<TabButtons v-model="range" :options="ranges" class="ml-auto" />
	</PageHeader>

	<div class="mx-auto max-w-4xl space-y-6 px-3 pb-16 pt-4 sm:px-5 md:pt-5">
		<Alert
			v-if="pending"
			theme="amber"
			:title="pending === 1 ? '1 request for more credits' : `${pending} requests for more credits`"
			description="People who ran out of credits today are waiting for an answer."
			:primary-action="{ label: 'Open requests', onClick: openRequests }"
		/>

		<TabButtons v-if="isMobile && loadError" v-model="range" :options="ranges" fluid />
		<div v-if="loadError" class="flex flex-col items-center gap-3 py-16 text-center" role="alert">
			<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
				<span class="lucide-circle-alert size-6" aria-hidden="true" />
			</div>
			<p class="text-base text-ink-gray-7">The numbers could not load</p>
			<p class="text-sm text-ink-gray-5">{{ loadError }}</p>
			<Button label="Try again" class="mt-2" @click="load" />
		</div>

		<template v-else>
			<section aria-label="Today" class="space-y-2">
				<h2 class="text-sm text-ink-gray-5">Today, since midnight UTC</h2>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
					<NumberCard
						title="Active people"
						:loading="loading"
						:value="loading ? null : now.active"
						:delta="loading ? undefined : now.active - yesterday.active"
						delta-caption="vs yesterday"
					/>
					<NumberCard
						title="Replies"
						:loading="loading"
						:value="loading ? null : now.replies"
						:delta="loading ? undefined : now.replies - yesterday.replies"
						delta-caption="vs yesterday"
					/>
					<NumberCard title="Credits used" :value="loading ? null : Math.round(now.credits)" :loading="loading" />
					<NumberCard title="Cost" :value="loading ? null : dollars(now.credits)" :loading="loading" />
					<NumberCard
						title="Out of credits"
						:loading="loading"
						:value="loading ? null : now.outOfCredits"
						:suffix="now.outOfCredits === 1 ? ' person' : ' people'"
						class="col-span-2 sm:col-span-1"
					/>
				</div>
			</section>

			<TabButtons v-if="isMobile" v-model="range" :options="ranges" fluid />

			<div class="h-64 rounded-5 border border-outline-gray-1 p-3 md:h-72 md:p-4">
				<BarChart
					title="Credits used per day"
					:subtitle="loading ? undefined : `${credits(rangeCredits)} credits, ${dollars(rangeCredits)}`"
					:data="daily"
					x="day"
					y="Credits"
					:loading="loading"
				/>
			</div>

			<div class="grid gap-6 md:grid-cols-2">
				<div class="h-64 rounded-5 border border-outline-gray-1 p-3 md:h-72 md:p-4">
					<LineChart title="Active people per day" :data="daily" x="day" y="Active people" :loading="loading" />
				</div>
				<div class="h-72 rounded-5 border border-outline-gray-1 p-3 md:p-4">
					<DonutChart title="Credits by model" :data="data?.byModel ?? []" category="model" value="credits" :loading="loading" />
				</div>
			</div>

			<section class="space-y-2">
				<div class="flex items-baseline justify-between">
					<h2 class="text-lg-semibold text-ink-gray-8">Who uses Ponder</h2>
					<RouterLink to="/people" class="text-sm text-ink-blue-link">All people</RouterLink>
				</div>

				<!-- Phone: a feed, one person a row, today's credits under the name. -->
				<List v-if="isMobile" class="-mx-3 list-row-px-3">
					<ListRows :items="top" v-slot="{ item }">
						<ListRow :route="`/people/${encodeURIComponent(item.id)}`" class="py-3">
							<ListCell class="self-start pt-0.5"><Avatar :label="item.name" size="lg" /></ListCell>
							<ListCell class="flex-col items-stretch gap-1.5">
								<span class="truncate text-base text-ink-gray-8">{{ item.name }}</span>
								<CreditBar :used="item.today.used" :limit="item.today.limit" />
							</ListCell>
							<ListCell class="flex-col items-end gap-0.5 self-start">
								<span class="text-sm tabular-nums text-ink-gray-7">{{ credits(item.credits) }}</span>
								<span class="text-xs text-ink-gray-5">{{ range }} days</span>
							</ListCell>
						</ListRow>
					</ListRows>
				</List>

				<List v-else :columns="['minmax(0,1fr)', '10rem', '6rem', '6rem', '6rem']" :row-height="52" class="-mx-3 list-row-px-3">
					<ListHeader>
						<ListHeaderCell>Person</ListHeaderCell>
						<ListHeaderCell>Today</ListHeaderCell>
						<ListHeaderCell class="justify-end">{{ range }}-day credits</ListHeaderCell>
						<ListHeaderCell class="justify-end">Replies</ListHeaderCell>
						<ListHeaderCell class="justify-end">Days active</ListHeaderCell>
					</ListHeader>
					<ListRows :items="top" v-slot="{ item }">
						<ListRow :route="`/people/${encodeURIComponent(item.id)}`">
							<ListCell class="gap-2.5">
								<Avatar :label="item.name" size="sm" />
								<span class="truncate text-base text-ink-gray-8">{{ item.name }}</span>
							</ListCell>
							<ListCell>
								<CreditBar :used="item.today.used" :limit="item.today.limit" />
							</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ credits(item.credits) }}</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ item.replies }}</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ item.activeDays }} of {{ range }}</ListCell>
						</ListRow>
					</ListRows>
				</List>

				<ListSkeleton v-if="loading" :avatar="isMobile ? 'lg' : 'sm'" :two-lines="isMobile" label="Loading people" />
			</section>
		</template>

		<p class="flex items-center gap-1.5 text-sm text-ink-gray-5">
			<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
			Admins see how much people use Ponder, not what they write.
		</p>
	</div>
</template>
