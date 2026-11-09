<script setup lang="ts">
import {
	Alert,
	Avatar,
	Badge,
	Breadcrumbs,
	Button,
	Dropdown,
	PageHeader,
	PageHeaderBackButton,
	PageHeaderMobile,
	Skeleton,
	toast,
} from "frappe-ui";
import { BarChart, DonutChart, NumberCard } from "frappe-ui/charts";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, ApiError, type Person, type PersonDetail } from "../api";
import CreditsDialog from "../components/CreditsDialog.vue";
import ExtraCreditsDialog from "../components/ExtraCreditsDialog.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { personActions } from "../lib/actions";
import { credits, date, dollars, lastActive, shortDay } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { settings } from "../store";

const props = defineProps<{ id: string }>();
const router = useRouter();

/** The page for one id: its answer, no one with that id (a 404), or a failure to retry. */
type PageState =
	| { kind: "loading" }
	| { kind: "loaded"; detail: PersonDetail }
	| { kind: "missing" }
	| { kind: "error"; message: string };
const state = ref<PageState>({ kind: "loading" });
const detail = computed(() => (state.value.kind === "loaded" ? state.value.detail : null));
const person = computed(() => detail.value?.person);

// Each load takes a number; an answer for an id no longer shown, or overtaken by a newer load, is dropped.
// Declared before the watch below, which calls load() at once.
let asked = 0;

// Another person's page starts from the skeleton, never with the last one's numbers.
watch(
	() => props.id,
	() => {
		state.value = { kind: "loading" };
		void load();
	},
	{ immediate: true },
);


/** Loads the page again. After a change it keeps the page on screen until the new numbers arrive. */
async function load() {
	const mine = ++asked;
	try {
		const data = await api<PersonDetail>(`/people/${encodeURIComponent(props.id)}`);
		if (mine !== asked) return;
		Object.assign(settings, data.settings);
		state.value = { kind: "loaded", detail: data };
	} catch (e) {
		if (mine !== asked) return;
		if (e instanceof ApiError && e.status === 404) state.value = { kind: "missing" };
		// A reload after a change that fails keeps the page, with a toast.
		else if (state.value.kind === "loaded") toast.error((e as Error).message);
		else state.value = { kind: "error", message: (e as Error).message };
	}
}

function retry() {
	state.value = { kind: "loading" };
	void load();
}

const creditsOpen = ref(false);
const extraOpen = ref(false);
const actions = computed(() =>
	person.value
		? personActions(person.value, {
				openCredits: () => (creditsOpen.value = true),
				giveExtra: () => (extraOpen.value = true),
				changed: load,
				removed: () => router.push("/people"),
				sessions: detail.value?.sessions.length,
			})
		: [],
);

async function giveExtra(amount: number) {
	const p = person.value as Person;
	await api(`/people/${encodeURIComponent(p.id)}/grant`, { body: { credits: amount } });
	toast.success(`Gave ${p.name} ${amount} extra credits for today`);
	await load();
}

const days = computed(() => detail.value?.days ?? []);
const week = computed(() => days.value.slice(-7));
const weekCredits = computed(() => Math.round(week.value.reduce((sum, day) => sum + day.credits, 0) * 10) / 10);
const weekReplies = computed(() => week.value.reduce((sum, day) => sum + day.replies, 0));
const perDay = computed(() => days.value.map((d) => ({ day: shortDay(d.date), Credits: d.credits })));

// Better Auth stores "No reason" when a ban has none.
const banText = computed(() => {
	const p = person.value;
	if (!p) return "";
	const reason = p.banReason && p.banReason !== "No reason" ? `Reason: ${p.banReason}.` : "No reason given.";
	return p.banExpires ? `${reason} Until ${date(p.banExpires)}.` : reason;
});

const limitText = computed(() =>
	person.value?.dailyCredits === null ? `${settings.defaultDailyCredits} (default)` : `${person.value?.dailyCredits} (own limit)`,
);
const details = computed(() => {
	const p = person.value;
	if (!p) return [];
	return [
		{ label: "Role", value: p.role === "admin" ? "Admin" : "User" },
		{ label: "Daily credits", value: limitText.value },
		...(p.status === "invited" ? [] : [{ label: "Extra today", value: p.today.extra ? `+${credits(p.today.extra)}` : "None" }]),
		{ label: "Note", value: p.note || "—" },
		{ label: "Invited", value: date(p.invitedAt) },
		{ label: "Invited by", value: p.invitedBy ?? "—" },
		{ label: "First sign-in", value: date(p.joinedAt) },
		{ label: "Last active", value: lastActive(p.lastActive) },
	];
});

const invitedText = computed(() => {
	const p = person.value;
	if (!p) return "";
	return `Invited ${lastActive(p.invitedAt)}${p.invitedBy ? ` by ${p.invitedBy}` : ""}. The invite doesn't expire.`;
});

async function emailInvite() {
	const p = person.value;
	if (!p) return;
	try {
		await api(`/invites/${encodeURIComponent(p.email)}/send`, { body: {} });
		toast.success(`Sent to ${p.email}`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

/** Charts draw in quickly, and not at all with reduced motion (as on the Overview). */
const chartMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? { animation: false } : { animationDuration: 250, animationDurationUpdate: 200 };
</script>

<template>
	<template v-if="person && detail">
		<PageHeaderMobile v-if="isMobile" :title="person.name">
			<template #prefix><PageHeaderBackButton :fallback-route="{ path: '/people' }" /></template>
			<template #suffix>
				<Dropdown :options="actions">
					<Button variant="ghost" icon="lucide-ellipsis" aria-label="Actions" />
				</Dropdown>
			</template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<Breadcrumbs :items="[{ label: 'People', route: '/people' }, { label: person.name }]" />
			<div class="ml-auto flex items-center gap-2">
				<Button label="Set daily credits" icon-left="lucide-gauge" @click="creditsOpen = true" />
				<Dropdown :options="actions">
					<Button icon="lucide-ellipsis" aria-label="More actions" />
				</Dropdown>
			</div>
		</PageHeader>

		<div data-slot="dashboard" class="flex min-h-0 flex-1 flex-col md:flex-row">
			<div class="min-w-0 flex-1 space-y-6 px-3 pb-6 pt-4 sm:px-5 md:pb-16 md:pt-5">
				<div class="flex items-center gap-3">
					<Avatar :label="person.name" :size="isMobile ? 'xl' : '2xl'" />
					<div class="min-w-0">
						<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<h1 class="truncate text-xl-semibold text-ink-gray-9 md:text-2xl-semibold">{{ person.name }}</h1>
							<Badge v-if="person.role === 'admin'" label="Admin" variant="outline" />
							<StatusBadge :status="person.status" />
						</div>
						<p class="truncate text-base text-ink-gray-6">{{ person.email }}</p>
					</div>
				</div>

				<Alert
					v-if="person.status === 'invited'"
					theme="blue"
					title="Hasn't signed in yet"
					:description="invitedText"
					:primary-action="{ label: 'Email the invite again', onClick: emailInvite }"
				/>
				<Alert v-if="person.status === 'banned'" theme="red" title="Banned" :description="banText" />

				<template v-if="person.status !== 'invited'">
					<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<NumberCard title="Credits today" :value="`${credits(person.today.used)} / ${credits(person.today.limit)}`" />
						<NumberCard title="Last 7 days" :value="credits(weekCredits)" :delta-caption="dollars(weekCredits)" />
						<NumberCard title="Replies, 7 days" :value="weekReplies" />
						<NumberCard title="Chats" :value="detail.chats" />
					</div>

					<div class="h-60 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<BarChart
							title="Credits per day, last 30 days"
							:data="perDay"
							x="day"
							y="Credits"
							palette="categorical"
							:echart-options="chartMotion"
							:x-axis="{ type: 'category', echartOptions: { axisLabel: { rotate: 0, interval: (index: number) => (perDay.length - 1 - index) % 4 === 0, showMinLabel: false, showMaxLabel: true, fontSize: 12 } } }"
							:y-axis="{ echartOptions: { axisLabel: { fontSize: 12 } } }"
						/>
					</div>

					<div class="h-72 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<DonutChart :echart-options="chartMotion" title="Models, last 30 days" :data="detail.models" category="model" value="credits" />
					</div>
				</template>

				<p v-if="!isMobile" class="flex items-center gap-1.5 text-sm text-ink-gray-5">
					<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
					Their chats are private. Admins see usage only.
				</p>
			</div>

			<!-- Desktop: a side panel. Phone: a section under the charts. -->
			<aside class="space-y-5 border-outline-gray-1 px-3 pb-16 sm:px-5 md:w-[20rem] md:shrink-0 md:border-l md:pt-5">
				<h2 v-if="isMobile" class="text-lg-semibold text-ink-gray-8">Details</h2>
				<dl class="space-y-3 text-base">
					<div v-for="row in details" :key="row.label" class="flex justify-between gap-3">
						<dt class="shrink-0 text-ink-gray-6">{{ row.label }}</dt>
						<dd class="truncate text-right tabular-nums text-ink-gray-8">{{ row.value }}</dd>
					</div>
				</dl>

				<div v-if="person.status !== 'invited'" class="space-y-2 border-t border-outline-gray-1 pt-5">
					<h2 class="text-sm text-ink-gray-5">Signed in on</h2>
					<ul v-if="detail.sessions.length" class="space-y-2">
						<li v-for="(session, index) in detail.sessions" :key="index" class="flex items-center gap-2 text-base">
							<span class="lucide-monitor-smartphone size-4 shrink-0 text-ink-gray-5" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate text-ink-gray-8">{{ session.device }}</span>
							<span class="text-sm text-ink-gray-5">{{ lastActive(session.lastUsed) }}</span>
						</li>
					</ul>
					<p v-else class="text-sm text-ink-gray-5">Not signed in anywhere.</p>
				</div>

				<p v-if="isMobile" class="flex items-center gap-1.5 text-sm text-ink-gray-5">
					<span class="lucide-lock size-3.5 shrink-0" aria-hidden="true" />
					Their chats are private. Admins see usage only.
				</p>
			</aside>
		</div>

		<CreditsDialog v-model:open="creditsOpen" :person="person" @saved="load" />
		<ExtraCreditsDialog
			v-model:open="extraOpen"
			:title="`Extra credits for ${person.name}`"
			confirm-label="Give credits"
			:suggested="person.dailyCredits ?? settings.defaultDailyCredits"
			:submit="giveExtra"
		/>
	</template>

	<div v-else-if="state.kind === 'missing'" class="flex flex-col items-center gap-3 px-3 py-24 text-center">
		<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
			<span class="lucide-user-x size-6" aria-hidden="true" />
		</div>
		<p class="text-base text-ink-gray-7">No one here</p>
		<p class="text-sm text-ink-gray-5">They may have been removed.</p>
		<Button label="All people" route="/people" class="mt-2" />
	</div>
	<div v-else-if="state.kind === 'error'" class="flex flex-col items-center gap-3 px-3 py-24 text-center" role="alert">
		<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
			<span class="lucide-circle-alert size-6" aria-hidden="true" />
		</div>
		<p class="text-base text-ink-gray-7">This page could not load</p>
		<p class="text-sm text-ink-gray-5">{{ state.message }}</p>
		<Button label="Try again" class="mt-2" @click="retry" />
	</div>
	<!-- Loading: the page's own frame, with skeletons where its numbers go. NumberCard
	     and the chart draw frappe-ui's own skeletons with `loading`. -->
	<template v-else>
		<PageHeaderMobile v-if="isMobile" title="">
			<template #prefix><PageHeaderBackButton :fallback-route="{ path: '/people' }" /></template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<Breadcrumbs :items="[{ label: 'People', route: '/people' }]" />
		</PageHeader>

		<div class="flex min-h-0 flex-1 flex-col md:flex-row" aria-busy="true" aria-label="Loading this person">
			<div class="min-w-0 flex-1 space-y-6 px-3 pb-6 pt-4 sm:px-5 md:pb-16 md:pt-5">
				<div class="flex items-center gap-3">
					<Skeleton class="size-10 shrink-0 rounded-full md:size-12" />
					<div class="min-w-0 flex-1 space-y-2">
						<Skeleton class="h-5 w-40 max-w-full rounded-4 md:h-6 md:w-56" />
						<Skeleton class="h-3.5 w-52 max-w-full rounded-4" />
					</div>
				</div>
				<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
					<NumberCard v-for="title in ['Credits today', 'Last 7 days', 'Replies, 7 days', 'Chats']" :key="title" :title="title" :value="null" loading />
				</div>
				<div class="h-60 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
					<BarChart title="Credits per day, last 30 days" :data="[]" x="day" y="Credits" loading />
				</div>
			</div>
			<aside class="space-y-3 border-outline-gray-1 px-3 pb-16 sm:px-5 md:w-[20rem] md:shrink-0 md:border-l md:pt-5">
				<div v-for="(width, row) in ['w-20', 'w-24', 'w-16', 'w-28', 'w-20']" :key="row" class="flex justify-between gap-3">
					<Skeleton class="h-3.5 w-20 rounded-4" />
					<Skeleton :class="['h-3.5 rounded-4', width]" />
				</div>
			</aside>
		</div>
	</template>
</template>
