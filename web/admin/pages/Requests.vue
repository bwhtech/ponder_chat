<script setup lang="ts">
import { Avatar, Badge, Button, PageHeader, PageHeaderMobile, dialog, toast } from "frappe-ui";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow, ListRows } from "frappe-ui/list";
import { computed, ref, watch } from "vue";
import { api, type DecidedRequest, type PendingRequest } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import CreditBar from "../components/CreditBar.vue";
import ExtraCreditsDialog from "../components/ExtraCreditsDialog.vue";
import ListSkeleton from "../components/ListSkeleton.vue";
import EmptyState from "../../EmptyState.vue";
import { credits, lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { counts, refreshCounts } from "../store";

/**
 * Requests for more credits: people who used today's credits and asked for more. Approve
 * gives extra credits for today. Decline leaves the limit as it is. Either way the
 * person gets an email, and can ask again later.
 */
const pending = ref<PendingRequest[]>([]);
const decided = ref<DecidedRequest[]>([]);
/** Until the first answer, a failure shows in place of the lists: an empty list would read as "no requests". */
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
const loading = computed(() => status.value.kind === "loading");

// Each load takes a number: an older answer that arrives late is dropped.
let asked = 0;

async function load() {
	const mine = ++asked;
	try {
		const data = await api<{ pending: PendingRequest[]; decided: DecidedRequest[] }>("/requests");
		if (mine !== asked) return;
		pending.value = data.pending;
		decided.value = data.decided;
		status.value = { kind: "loaded" };
	} catch (e) {
		if (mine !== asked) return;
		// A reload that fails keeps the lists on screen, with a toast.
		if (status.value.kind === "loaded") toast.error((e as Error).message);
		else status.value = { kind: "error", message: (e as Error).message };
	}
}

function retry() {
	status.value = { kind: "loading" };
	void load();
}
void load();
// The sidebar count is checked every minute: a new request shows here too.
watch(() => counts.pendingRequests, load);

const approving = ref<PendingRequest | null>(null);
const approveOpen = ref(false);
const approveTitle = computed(() => `Approve ${approving.value?.person.name ?? ""}'s request`);

function approve(request: PendingRequest) {
	approving.value = request;
	approveOpen.value = true;
}

async function submitApproval(amount: number) {
	const request = approving.value as PendingRequest;
	await api(`/requests/${request.id}/approve`, { body: { credits: amount } });
	toast.success(`Gave ${request.person.name} ${amount} extra credits for today`);
	await Promise.all([load(), refreshCounts()]);
}

function decline(request: PendingRequest) {
	dialog.confirm({
		title: `Decline ${request.person.name}'s request?`,
		message: "Their limit stays as it is, and their credits refill at midnight UTC. They get an email, and can ask again.",
		confirmLabel: "Decline",
		onConfirm: async () => {
			await api(`/requests/${request.id}/decline`, { body: {} });
			toast.success(`Declined ${request.person.name}'s request`);
			await Promise.all([load(), refreshCounts()]);
		},
	});
}

const answer = (request: DecidedRequest) =>
	request.status === "approved" ? `+${credits(request.credits ?? 0)} credits` : "No credits";
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Requests">
		<template #prefix><AccountMenu compact /></template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<div class="mx-auto flex w-full max-w-[61.5rem] items-center gap-2">
			<h1 class="text-lg-semibold text-ink-gray-9">Requests</h1>
		</div>
	</PageHeader>

	<div class="mx-auto w-full max-w-5xl space-y-8 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<section class="space-y-3">
			<h2 v-if="loading || pending.length || decided.length || status.kind === 'error'" class="text-base-semibold text-ink-gray-9">Waiting for an answer</h2>

			<!-- Phone: one request a row, with its two buttons under the numbers. -->
			<List v-if="isMobile" class="-mx-3 list-row-px-3">
				<ListRows :items="pending" v-slot="{ item }">
					<ListRow class="py-3">
						<ListCell class="self-start pt-0.5"><Avatar :label="item.person.name" size="lg" /></ListCell>
						<ListCell class="flex-col items-stretch gap-1.5">
							<div class="flex items-baseline justify-between gap-2">
								<RouterLink :to="`/people/${encodeURIComponent(item.person.id)}`" class="truncate text-base text-ink-gray-8">
									{{ item.person.name }}
								</RouterLink>
								<span class="shrink-0 text-sm text-ink-gray-6">{{ lastActive(item.createdAt) }}</span>
							</div>
							<CreditBar :used="item.today.used" :limit="item.today.limit" />
							<span class="text-sm text-ink-gray-6">{{ credits(item.week) }} credits in the last 7 days</span>
							<div class="flex gap-2 pt-1">
								<Button label="Decline" class="flex-1" @click="decline(item)" />
								<Button variant="solid" theme="gray" label="Approve" class="flex-1" @click="approve(item)" />
							</div>
						</ListCell>
					</ListRow>
				</ListRows>
			</List>

			<div v-else-if="loading || pending.length" class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
				<List :columns="['minmax(0,1fr)', '8.5rem', '10rem', '6rem', '11rem']" :row-height="60" class="min-w-[48rem] list-row-px-3">
					<ListHeader>
						<ListHeaderCell>Person</ListHeaderCell>
						<ListHeaderCell>Asked</ListHeaderCell>
						<ListHeaderCell>Credits today</ListHeaderCell>
						<ListHeaderCell class="justify-end">Last 7 days</ListHeaderCell>
						<ListHeaderCell />
					</ListHeader>
					<ListRows :items="pending" v-slot="{ item }">
						<ListRow>
							<ListCell class="gap-3">
								<Avatar :label="item.person.name" size="md" />
								<RouterLink :to="`/people/${encodeURIComponent(item.person.id)}`" class="min-w-0">
									<span class="block truncate text-base text-ink-gray-8">{{ item.person.name }}</span>
									<span class="block truncate text-sm text-ink-gray-6">{{ item.person.email }}</span>
								</RouterLink>
							</ListCell>
							<ListCell class="truncate text-sm text-ink-gray-6">{{ lastActive(item.createdAt) }}</ListCell>
							<ListCell><CreditBar :used="item.today.used" :limit="item.today.limit" /></ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">{{ credits(item.week) }}</ListCell>
							<ListCell class="justify-end gap-2">
								<Button label="Decline" @click="decline(item)" />
								<Button variant="solid" theme="gray" label="Approve" @click="approve(item)" />
							</ListCell>
						</ListRow>
					</ListRows>
				</List>
			</div>

			<ListSkeleton v-if="loading" :rows="3" :avatar="isMobile ? 'lg' : 'md'" two-lines label="Loading requests" />
			<EmptyState v-else-if="status.kind === 'error'" icon="lucide-circle-alert" title="The requests could not load" :body="status.message" alert>
				<Button label="Try again" @click="retry" />
			</EmptyState>
			<EmptyState v-else-if="!pending.length" icon="lucide-inbox" title="No requests waiting" body="When someone uses today's credits and asks for more, it shows here." />
		</section>

		<section v-if="decided.length" class="space-y-3">
			<h2 class="text-base-semibold text-ink-gray-9">Answered, last 30 days</h2>

			<List v-if="isMobile" class="-mx-3 list-row-px-3">
				<ListRows :items="decided" v-slot="{ item }">
					<ListRow :route="`/people/${encodeURIComponent(item.person.id)}`" class="py-3">
						<ListCell class="self-start pt-0.5"><Avatar :label="item.person.name" size="lg" /></ListCell>
						<ListCell class="flex-col items-stretch gap-0.5">
							<span class="truncate text-base text-ink-gray-8">{{ item.person.name }}</span>
							<span class="truncate text-sm text-ink-gray-6">{{ item.decidedBy }}, {{ lastActive(item.decidedAt) }}</span>
						</ListCell>
						<ListCell class="flex-col items-end gap-1 self-start">
							<Badge
								:label="item.status === 'approved' ? 'Approved' : 'Declined'"
								:theme="item.status === 'approved' ? 'green' : 'gray'"
								variant="subtle"
							/>
							<span class="text-xs tabular-nums text-ink-gray-6">{{ answer(item) }}</span>
						</ListCell>
					</ListRow>
				</ListRows>
			</List>

			<div v-else class="scroll-fade-x scrollbar-thin -mx-3 overflow-x-auto [--scroll-fade-range:24px] [--scroll-fade-size:24px]">
				<List :columns="['minmax(0,1fr)', '8.5rem', '7rem', '7rem', '10rem']" :row-height="52" class="min-w-[44rem] list-row-px-3">
					<ListHeader>
						<ListHeaderCell>Person</ListHeaderCell>
						<ListHeaderCell>Asked</ListHeaderCell>
						<ListHeaderCell>Answer</ListHeaderCell>
						<ListHeaderCell class="justify-end">Credits</ListHeaderCell>
						<ListHeaderCell>Answered by</ListHeaderCell>
					</ListHeader>
					<ListRows :items="decided" v-slot="{ item }">
						<ListRow :route="`/people/${encodeURIComponent(item.person.id)}`">
							<ListCell class="gap-2.5">
								<Avatar :label="item.person.name" size="sm" />
								<span class="truncate text-base text-ink-gray-8">{{ item.person.name }}</span>
							</ListCell>
							<ListCell class="text-sm text-ink-gray-6">{{ lastActive(item.createdAt) }}</ListCell>
							<ListCell>
								<Badge
									:label="item.status === 'approved' ? 'Approved' : 'Declined'"
									:theme="item.status === 'approved' ? 'green' : 'gray'"
									variant="subtle"
								/>
							</ListCell>
							<ListCell class="justify-end text-sm tabular-nums text-ink-gray-7">
								<template v-if="item.status === 'approved'">+{{ credits(item.credits ?? 0) }}</template>
								<span v-else class="text-ink-gray-4">—</span>
							</ListCell>
							<ListCell>
								<div class="min-w-0">
									<div class="truncate text-sm text-ink-gray-7">{{ item.decidedBy }}</div>
									<div class="truncate text-xs text-ink-gray-5">{{ lastActive(item.decidedAt) }}</div>
								</div>
							</ListCell>
						</ListRow>
					</ListRows>
				</List>
			</div>
		</section>
	</div>

	<ExtraCreditsDialog
		v-model:open="approveOpen"
		:title="approveTitle"
		confirm-label="Approve"
		:suggested="approving?.dailyLimit ?? 1"
		:submit="submitApproval"
	/>
</template>
