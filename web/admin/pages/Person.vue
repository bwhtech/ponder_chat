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
import EmptyState from "../../EmptyState.vue";
import { personActions } from "../lib/actions";
import { shortDay } from "../../dates";
import PrivacyNote from "../components/PrivacyNote.vue";
import { count } from "../../numbers";
import { credits, date, dollars, lastActive } from "../lib/format";
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
const monthCredits = computed(() => perDay.value.reduce((total, day) => total + day.Credits, 0));

// Better Auth stores "No reason" when a ban has none.
const banText = computed(() => {
	const p = person.value;
	if (!p) return "";
	const reason = p.banReason && p.banReason !== "No reason" ? `Reason: ${p.banReason}.` : "No reason given.";
	return p.banExpires ? `${reason} Until ${date(p.banExpires)}.` : reason;
});

/** The daily limit leads; where it comes from follows in a quieter tone. */
const limit = computed(() =>
	person.value?.dailyCredits === null
		? { value: credits(settings.defaultDailyCredits), hint: "(default)" }
		: { value: credits(person.value?.dailyCredits ?? 0), hint: "(own limit)" },
);
/** Shown under the charts on desktop, and at the end of the side panel on phones. */
const PRIVACY_NOTE = "Their chats are private. Admins see usage only.";
/** The details' labels, in order. The loading frame shows them as they are, with bars only for the values. */
const DETAIL_LABELS = ["Role", "Daily credits", "Extra today", "Note", "Invited", "Invited by", "First sign-in", "Last active"] as const;
type DetailLabel = (typeof DETAIL_LABELS)[number];

const details = computed(() => {
	const p = person.value;
	if (!p) return [];
	const values: Record<DetailLabel, { value: string; hint?: string } | null> = {
		Role: { value: p.role === "admin" ? "Admin" : "User" },
		"Daily credits": { value: limit.value.value, hint: limit.value.hint },
		"Extra today": p.status === "invited" ? null : { value: p.today.extra ? `+${credits(p.today.extra)}` : "None" },
		Note: { value: p.note || "—" },
		Invited: { value: date(p.invitedAt) },
		"Invited by": { value: p.invitedBy ?? "—" },
		"First sign-in": { value: date(p.joinedAt) },
		"Last active": { value: lastActive(p.lastActive) },
	};
	return DETAIL_LABELS.flatMap((label) => (values[label] ? [{ label, ...values[label] }] : []));
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
			<Breadcrumbs class="-ml-0.5" :items="[{ label: 'People', route: '/people' }, { label: person.name }]" />
			<div class="ml-auto flex items-center gap-2">
				<Button label="Set daily credits" icon-left="lucide-gauge" @click="creditsOpen = true" />
				<Dropdown :options="actions">
					<Button icon="lucide-ellipsis" aria-label="More actions" />
				</Dropdown>
			</div>
		</PageHeader>

		<div class="flex min-h-0 flex-1 flex-col md:flex-row">
			<div class="min-w-0 flex-1 space-y-6 px-3 pb-6 pt-4 sm:px-5 md:pb-16 md:pt-6">
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

				<div v-if="person.status !== 'invited'" class="space-y-4">
					<div data-slot="dashboard" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
						<NumberCard title="Credits today" :value="`${credits(person.today.used)} / ${credits(person.today.limit)}`" />
						<NumberCard title="Credits, last 7 days" :value="weekCredits" :format="credits" :delta-caption="dollars(weekCredits)" />
						<NumberCard title="Replies, last 7 days" :value="weekReplies" :format="count" />
						<NumberCard title="Chats" :value="detail.chats" :format="count" />
					</div>

					<div data-slot="dashboard" class="h-60 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<BarChart
							title="Credits used per day"
							:subtitle="`Last 30 days · ${credits(monthCredits)} credits · ${dollars(monthCredits)}`"
							:data="perDay"
							x="day"
							y="Credits"
							palette="categorical"
							:echart-options="chartMotion"
							:x-axis="{ type: 'category', echartOptions: { axisLabel: { rotate: 0, interval: (index: number) => (perDay.length - 1 - index) % (isMobile ? 7 : 4) === 0, showMinLabel: false, showMaxLabel: true, fontSize: 12 } } }"
							:y-axis="{ echartOptions: { axisLabel: { fontSize: 12 } } }"
						/>
					</div>

					<div data-slot="dashboard" class="h-72 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<DonutChart :echart-options="chartMotion" :format="credits" title="Credits by model" :subtitle="`Last 30 days · ${credits(monthCredits)} credits`" :data="detail.models" category="model" value="credits" />
					</div>
				</div>

				<PrivacyNote v-if="!isMobile">{{ PRIVACY_NOTE }}</PrivacyNote>
			</div>

			<!-- Desktop: a side panel. Phone: a section under the charts. -->
			<aside aria-label="Details" class="space-y-5 px-3 pb-16 sm:px-5 md:w-[20rem] md:shrink-0 md:pt-6 md:relative md:before:absolute md:before:bottom-16 md:before:left-0 md:before:top-6 md:before:w-px md:before:bg-[var(--outline-gray-1)] md:before:content-['']">
				<h2 v-if="isMobile" class="text-base-semibold text-ink-gray-9">Details</h2>
				<dl class="space-y-3 text-base">
					<div v-for="row in details" :key="row.label" class="flex justify-between gap-3">
						<dt class="shrink-0 text-ink-gray-6">{{ row.label }}</dt>
						<dd class="truncate text-right tabular-nums" :class="row.value === '—' ? 'text-ink-gray-4' : 'text-ink-gray-8'">
							{{ row.value }}<span v-if="row.hint" class="ml-1 text-ink-gray-5">{{ row.hint }}</span>
						</dd>
					</div>
				</dl>

				<div v-if="person.status !== 'invited'" class="space-y-2 border-t border-outline-gray-1 pt-5">
					<h2 :class="isMobile ? 'text-base-semibold text-ink-gray-9' : 'text-sm text-ink-gray-6'">Signed in on</h2>
					<ul v-if="detail.sessions.length" class="space-y-3">
						<li v-for="(session, index) in detail.sessions" :key="index" class="flex items-center gap-2 text-base">
							<span class="lucide-monitor-smartphone size-4 shrink-0 text-ink-gray-5" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate text-ink-gray-8">{{ session.device }}</span>
							<span class="text-xs text-ink-gray-5">{{ lastActive(session.lastUsed) }}</span>
						</li>
					</ul>
					<p v-else class="text-sm text-ink-gray-6">Not signed in anywhere.</p>
				</div>

				<PrivacyNote v-if="isMobile">{{ PRIVACY_NOTE }}</PrivacyNote>
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

	<!-- Missing, error and loading keep the page's own frame. While loading, skeletons stand where its
	     numbers go; NumberCard and the chart draw frappe-ui's own skeletons with `loading`. -->
	<template v-else>
		<PageHeaderMobile v-if="isMobile" :title="state.kind === 'missing' ? 'Not found' : state.kind === 'error' ? 'Could not load' : ''">
			<template #prefix><PageHeaderBackButton :fallback-route="{ path: '/people' }" /></template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<!-- Loading: "People" stays a parent link, as it is once loaded, and a bar stands where the name lands. Same classes as frappe-ui's Breadcrumbs. -->
			<nav v-if="state.kind === 'loading'" aria-label="Breadcrumb" class="-ml-0.5 flex items-center leading-tighter">
				<RouterLink to="/people" class="rounded-4 px-0.5 py-1 text-lg-medium leading-tighter text-ink-gray-5 hover:text-ink-gray-7">People</RouterLink>
				<span class="mx-0.5 text-base text-ink-gray-4" aria-hidden="true">/</span>
				<span class="flex px-0.5 py-1"><Skeleton class="h-3.5 w-16 rounded-4" /></span>
			</nav>
			<Breadcrumbs v-else class="-ml-0.5" :items="[{ label: 'People', route: '/people' }, { label: state.kind === 'missing' ? 'Not found' : 'Could not load' }]" />
			<div v-if="state.kind === 'loading'" class="ml-auto flex items-center gap-2">
				<Button label="Set daily credits" icon-left="lucide-gauge" disabled />
				<Button icon="lucide-ellipsis" aria-label="More actions" disabled />
			</div>
		</PageHeader>

		<div v-if="state.kind === 'missing' || state.kind === 'error'" class="px-3 pt-4 sm:px-5 md:pt-6">
			<EmptyState v-if="state.kind === 'missing'" icon="lucide-user-x" title="No one here" body="They may have been removed.">
				<Button label="All people" route="/people" />
			</EmptyState>
			<EmptyState v-else icon="lucide-circle-alert" title="This page could not load" :body="state.message" alert>
				<Button label="Try again" @click="retry" />
			</EmptyState>
		</div>
		<div v-else class="flex min-h-0 flex-1 flex-col md:flex-row" aria-busy="true" aria-label="Loading this person">
			<div class="min-w-0 flex-1 space-y-6 px-3 pb-6 pt-4 sm:px-5 md:pb-16 md:pt-6">
				<div class="flex items-center gap-3">
					<Skeleton class="size-8 shrink-0 rounded-full md:size-10" />
					<div class="min-w-0 flex-1">
						<div class="flex h-[1lh] items-center text-xl-semibold md:text-2xl-semibold">
							<Skeleton class="h-5 w-40 max-w-full rounded-4 md:w-56" />
						</div>
						<div class="flex h-[1lh] items-center text-base">
							<Skeleton class="h-3.5 w-52 max-w-full rounded-4" />
						</div>
					</div>
				</div>
				<div class="space-y-4">
					<div data-slot="dashboard" class="grid grid-cols-2 gap-4 lg:grid-cols-4">
						<NumberCard v-for="title in ['Credits today', 'Credits, last 7 days', 'Replies, last 7 days', 'Chats']" :key="title" :title="title" :value="null" loading />
					</div>
					<div data-slot="dashboard" class="h-60 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<BarChart title="Credits used per day" :data="[]" x="day" y="Credits" loading />
					</div>
					<div data-slot="dashboard" class="h-72 rounded-4 border border-outline-gray-1 bg-surface-elevation-2 p-3 md:h-64 md:p-4">
						<DonutChart title="Credits by model" :data="[]" category="model" value="credits" loading />
					</div>
				</div>
				<PrivacyNote v-if="!isMobile">{{ PRIVACY_NOTE }}</PrivacyNote>
			</div>
			<aside aria-label="Details" class="space-y-5 px-3 pb-16 sm:px-5 md:w-[20rem] md:shrink-0 md:pt-6 md:relative md:before:absolute md:before:bottom-16 md:before:left-0 md:before:top-6 md:before:w-px md:before:bg-[var(--outline-gray-1)] md:before:content-['']">
				<h2 v-if="isMobile" class="text-base-semibold text-ink-gray-9">Details</h2>
				<dl class="space-y-3 text-base">
					<div v-for="(label, row) in DETAIL_LABELS" :key="label" class="flex h-[1lh] items-center justify-between gap-3">
						<dt class="shrink-0 text-ink-gray-6">{{ label }}</dt>
						<dd><Skeleton :class="['h-3.5 rounded-4', ['w-12', 'w-20', 'w-10', 'w-6', 'w-6', 'w-6', 'w-24', 'w-20'][row]]" /></dd>
					</div>
				</dl>
				<div class="space-y-2 border-t border-outline-gray-1 pt-5">
					<h2 :class="isMobile ? 'text-base-semibold text-ink-gray-9' : 'text-sm text-ink-gray-6'">Signed in on</h2>
					<div class="space-y-3 text-base">
						<div v-for="(width, index) in ['w-28', 'w-32', 'w-28']" :key="index" class="flex h-[1lh] items-center gap-2">
							<Skeleton class="size-4 shrink-0 rounded-4" />
							<Skeleton :class="['h-3.5 flex-none rounded-4', width]" />
							<Skeleton class="ml-auto h-3 w-16 rounded-4" />
						</div>
					</div>
				</div>

				<PrivacyNote v-if="isMobile">{{ PRIVACY_NOTE }}</PrivacyNote>
			</aside>
		</div>
	</template>
</template>
