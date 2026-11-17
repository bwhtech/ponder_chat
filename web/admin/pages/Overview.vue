<script setup lang="ts">
import { Alert, Avatar, Button, PageHeader, PageHeaderMobile, Skeleton, TabButtons } from "frappe-ui";
import { BarChart, DonutChart, NumberCard } from "frappe-ui/charts";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { admin, unwrap, type Overview } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import CreditBar from "../components/CreditBar.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import EmptyState from "../../EmptyState.vue";
import { shortDay } from "../../dates";
import PrivacyNote from "../components/PrivacyNote.vue";
import { count } from "../../numbers";
import { credits, dollars, money } from "../lib/format";
import { systemLines } from "../lib/system-spend";
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
		// The tabs hold one of the three ranges.
		const overview = await unwrap(admin.overview.$get({ query: { days: range.value as "7" | "14" | "30" } }));
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
/** Charts draw in quickly, and not at all with reduced motion: frappe-ui's own default ignores the setting. */
const chartMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? { animation: false } : { animationDuration: 250, animationDurationUpdate: 200 };
/**
 * Which day labels the time charts print, counted back from today so today always has a label
 * and the steps stay even. Phones print fewer, so no label collides and gets dropped.
 */
const dateTicks = (index: number) => {
	const days = daily.value.length;
	const step = isMobile.value ? (days <= 7 ? 2 : days <= 14 ? 3 : 7) : days <= 7 ? 1 : days <= 14 ? 2 : 4;
	return (daily.value.length - 1 - index) % step === 0;
};
/** The busiest day in the range, for the people chart's subtitle. */
const peakPeople = computed(() => Math.max(0, ...daily.value.map((day) => day["Active people"])));
const now = computed(() => data.value?.today ?? { active: 0, replies: 0, credits: 0, outOfCredits: 0 });
const yesterday = computed(() => data.value?.yesterday ?? { active: 0, replies: 0 });
const top = computed(() => data.value?.people ?? []);
const pending = computed(() => counts.pendingRequests);
const system = computed(() => systemLines(data.value?.system));

function openRequests() {
	void router.push("/requests");
}
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Overview">
		<template #prefix><AccountMenu compact /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">Overview</h1>
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<Alert
			v-if="pending"
			theme="amber"
			:title="pending === 1 ? '1 request for more credits' : `${pending} requests for more credits`"
			description="People who ran out of credits today are waiting for an answer."
			:primary-action="{ label: 'Open requests', onClick: openRequests }"
		/>

		<TabButtons v-if="isMobile && loadError" v-model="range" :options="ranges" fluid />
		<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The numbers could not load" :body="loadError" alert>
			<Button label="Try again" @click="load" />
		</EmptyState>

		<template v-else>
			<section aria-label="Today" class="space-y-3">
				<h2 class="text-base-semibold text-ink-gray-9">Today<span class="ml-1 text-sm font-normal text-ink-gray-5">· since midnight UTC</span></h2>
				<div data-slot="dashboard" class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
					<NumberCard
						title="Active people"
						:loading="loading"
						:value="loading ? null : now.active"
						:format="count"
						:delta="loading ? undefined : now.active - yesterday.active"
						delta-caption="vs yesterday"
					/>
					<NumberCard
						title="Replies"
						:loading="loading"
						:value="loading ? null : now.replies"
						:format="count"
						:delta="loading ? undefined : now.replies - yesterday.replies"
						delta-caption="vs yesterday"
					/>
					<NumberCard title="Credits used" :value="loading ? null : now.credits" :format="credits" :loading="loading" />
					<NumberCard title="Cost" :value="loading ? null : now.credits" :format="dollars" :loading="loading" />
					<NumberCard
						title="People out of credits"
						:loading="loading"
						:value="loading ? null : now.outOfCredits"
						:format="count"
						class="col-span-2 sm:col-span-1"
					/>
				</div>
			</section>

			<section aria-label="Over time" class="space-y-3">
				<template v-if="isMobile">
					<h2 class="text-base-semibold text-ink-gray-9">Over time</h2>
					<TabButtons v-model="range" :options="ranges" fluid />
				</template>
				<div v-else class="flex min-h-7 items-center">
					<h2 class="text-base-semibold text-ink-gray-9">Over time</h2>
					<TabButtons v-model="range" :options="ranges" class="ml-auto" aria-label="Range for the charts" />
				</div>

				<div class="space-y-4">
					<div data-slot="dashboard" class="h-64 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<BarChart
							title="Credits used per day"
							:subtitle="loading ? undefined : `Last ${range} days · ${credits(rangeCredits)} credits · ${dollars(rangeCredits)}`"
							:data="daily"
							x="day"
							y="Credits"
							palette="categorical"
							:echart-options="chartMotion"
							:x-axis="{ type: 'category', echartOptions: { axisLabel: { rotate: 0, interval: dateTicks, showMinLabel: false, showMaxLabel: true, fontSize: 12 } } }"
							:y-axis="{ echartOptions: { minInterval: 1, axisLabel: { fontSize: 12 } } }"
							:loading="loading"
						/>
					</div>

					<div class="grid gap-4 md:grid-cols-2">
						<div data-slot="dashboard" class="h-64 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
							<BarChart
								title="Active people per day"
								:subtitle="loading ? undefined : `Busiest day · ${peakPeople} ${peakPeople === 1 ? 'person' : 'people'}`"
								:data="daily"
								x="day"
								y="Active people"
								palette="categorical"
								:echart-options="chartMotion"
								:x-axis="{ type: 'category', echartOptions: { axisLabel: { rotate: 0, interval: dateTicks, showMinLabel: false, showMaxLabel: true, fontSize: 12 } } }"
								:y-axis="{ echartOptions: { minInterval: 1, axisLabel: { fontSize: 12 } } }"
								:loading="loading"
							/>
						</div>
						<div data-slot="dashboard" class="h-64 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:p-4">
							<DonutChart :echart-options="chartMotion" :format="credits" title="Credits by model" :subtitle="loading ? undefined : `Last ${range} days · ${credits(rangeCredits)} credits`" :data="data?.byModel ?? []" category="model" value="credits" :loading="loading" />
						</div>
					</div>
				</div>
			</section>

			<section class="space-y-3">
				<div class="flex items-baseline justify-between">
					<h2 class="text-base-semibold text-ink-gray-9">Who uses Ponder</h2>
					<RouterLink to="/people" class="flex items-center gap-1 rounded-4 text-sm text-ink-gray-6 hover:text-ink-gray-8">All people<span class="lucide-arrow-right size-3.5" aria-hidden="true" /></RouterLink>
				</div>

				<!-- Phone: a feed, one person a row, today's credits under the name. -->
				<List v-if="isMobile && top.length" class="-mx-3 list-row-px-3">
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

				<div v-else-if="!isMobile && (loading || top.length)" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
					<List :columns="['minmax(0,1fr)', '10rem', '6rem', '6rem', '6rem']" :row-height="52" class="min-w-[40rem] list-row-px-3">
						<ListHeader>
							<ListHeaderCell>Person</ListHeaderCell>
							<ListHeaderCell>Credits today</ListHeaderCell>
							<ListHeaderCell class="justify-end">Last {{ range }} days</ListHeaderCell>
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
								<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ credits(item.replies) }}</ListCell>
								<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ item.activeDays }} of {{ range }}</ListCell>
							</ListRow>
						</ListRows>
					</List>
				</div>
				<EmptyState v-else-if="!loading" icon="lucide-users" title="No one has used Ponder yet" body="People show here after their first reply." />

				<ListSkeleton v-if="loading" :avatar="isMobile ? 'lg' : 'sm'" :two-lines="isMobile" label="Loading people" />
			</section>

			<!-- The app's own calls (server/admin/usage.ts): the names are known, so only the numbers wait. -->
			<section aria-label="System" class="space-y-3" data-slot="system-spend">
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="text-base-semibold text-ink-gray-9">System</h2>
					<span class="flex h-[1lh] items-center text-sm tabular-nums text-ink-gray-6">
						<Skeleton v-if="loading" class="h-3 w-28 rounded-4" />
						<template v-else>Last {{ range }} days · {{ money(data?.system.usd ?? 0) }}</template>
					</span>
				</div>
				<p class="text-p-sm text-ink-gray-6">What the app's own model calls cost. They are not counted against anyone's credits.</p>
				<List :columns="isMobile ? ['minmax(0,1fr)', '4rem', '5rem'] : ['minmax(0,1fr)', '6rem', '6rem']" :row-height="52" class="-mx-3 list-row-px-3">
					<ListHeader>
						<ListHeaderCell>Call</ListHeaderCell>
						<ListHeaderCell class="justify-end">Calls</ListHeaderCell>
						<ListHeaderCell class="justify-end">Cost</ListHeaderCell>
					</ListHeader>
					<ListRows :items="system" row-key="functionId" v-slot="{ item }">
						<ListRow :data-function="item.functionId">
							<ListCell>
								<div class="min-w-0">
									<div class="truncate text-base text-ink-gray-8">{{ item.label }}</div>
									<div v-if="item.what" class="truncate text-sm text-ink-gray-6">{{ item.what }}</div>
								</div>
							</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">
								<Skeleton v-if="item.calls === null" class="h-3 w-8 rounded-4" />
								<template v-else>{{ count(item.calls) }}</template>
							</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">
								<Skeleton v-if="item.usd === null" class="h-3 w-12 rounded-4" />
								<template v-else>{{ money(item.usd) }}</template>
							</ListCell>
						</ListRow>
					</ListRows>
				</List>
			</section>
		</template>

		<PrivacyNote>Admins see how much people use Ponder, not what they write.</PrivacyNote>
	</div>
</template>
