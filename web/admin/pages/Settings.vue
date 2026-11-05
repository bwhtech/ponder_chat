<script setup lang="ts">
import { Avatar, Button, PageHeader, PageHeaderMobile, SettingsRow, TextInput, dialog, toast } from "frappe-ui";
import { computed, ref } from "vue";
import { api, type Settings } from "../api";
import AccountMenu from "../components/AccountMenu.vue";
import { creditValue, resetTime } from "../lib/format";
import { isMobile } from "../lib/viewport";
import { settings } from "../store";

type Admin = { id: string; name: string; email: string };

const saved = ref<Settings | null>(null);
const admins = ref<Admin[]>([]);
const defaultCredits = ref("");
const perUsd = ref("");
const saving = ref(false);

async function load() {
	try {
		const data = await api<Settings & { admins: Admin[] }>("/settings");
		show(data);
		admins.value = data.admins;
	} catch (e) {
		toast.error((e as Error).message);
	}
}
void load();

function show(next: Settings) {
	saved.value = { defaultDailyCredits: next.defaultDailyCredits, creditsPerUsd: next.creditsPerUsd };
	Object.assign(settings, saved.value);
	defaultCredits.value = String(next.defaultDailyCredits);
	perUsd.value = String(next.creditsPerUsd);
}

const wholeNumber = (value: string, min: number) => {
	const n = Number(value);
	return value.trim() !== "" && Number.isInteger(n) && n >= min;
};
const defaultError = computed(() => (wholeNumber(defaultCredits.value, 0) ? "" : "Enter a whole number, 0 or more."));
const perUsdError = computed(() => (wholeNumber(perUsd.value, 1) ? "" : "Enter a whole number, 1 or more."));

const valueChanged = computed(() => perUsd.value !== String(saved.value?.creditsPerUsd));
const changed = computed(() => defaultCredits.value !== String(saved.value?.defaultDailyCredits) || valueChanged.value);
const canSave = computed(() => Boolean(saved.value) && changed.value && !defaultError.value && !perUsdError.value);

async function apply() {
	saving.value = true;
	try {
		const body = { defaultDailyCredits: Number(defaultCredits.value), creditsPerUsd: Number(perUsd.value) };
		show(await api<Settings>("/settings", { method: "PUT", body }));
		toast.success("Settings saved");
	} finally {
		saving.value = false;
	}
}

function save() {
	if (!canSave.value || !saved.value) return;
	if (!valueChanged.value) return void apply().catch((e: Error) => toast.error(e.message));
	// A new credit value changes what every limit is worth, today's use included.
	const before = creditValue(saved.value.creditsPerUsd);
	const after = creditValue(Number(perUsd.value));
	const budget = (Number(defaultCredits.value) / Number(perUsd.value)).toFixed(2);
	dialog.confirm({
		title: "Change what a credit is worth?",
		message: `One credit goes from ${before} to ${after}. Limits keep their numbers, so a default of ${defaultCredits.value} credits becomes $${budget} a day. Today's use is counted again at the new value.`,
		confirmLabel: "Change it",
		onConfirm: apply,
	});
}
</script>

<template>
	<PageHeaderMobile v-if="isMobile" title="Settings">
		<template #prefix><AccountMenu compact /></template>
		<template #suffix>
			<Button variant="ghost" label="Save" :loading="saving" :disabled="!canSave" @click="save" />
		</template>
	</PageHeaderMobile>
	<PageHeader v-else>
		<h1 class="text-2xl text-ink-gray-9">Settings</h1>
		<Button variant="solid" theme="gray" label="Save" class="ml-auto" :loading="saving" :disabled="!canSave" @click="save" />
	</PageHeader>

	<div class="mx-auto max-w-[770px] space-y-11 px-3 pb-16 pt-4 sm:px-5 md:pt-6">
		<section class="space-y-2">
			<h2 class="text-lg-semibold text-ink-gray-8">Credits</h2>
			<div class="divide-y divide-outline-gray-1">
				<SettingsRow title="Default daily credits">
					<div class="flex flex-col items-end gap-1">
						<TextInput v-model="defaultCredits" type="number" class="w-28" aria-label="Default daily credits" />
						<span v-if="defaultError && saved" class="text-xs text-ink-red-5">{{ defaultError }}</span>
					</div>
				</SettingsRow>
				<SettingsRow title="Credits per US dollar" :description="perUsdError ? '' : `1 credit = ${creditValue(Number(perUsd))}`">
					<div class="flex flex-col items-end gap-1">
						<TextInput v-model="perUsd" type="number" class="w-28" aria-label="Credits per US dollar" />
						<span v-if="perUsdError && saved" class="text-xs text-ink-red-5">{{ perUsdError }}</span>
					</div>
				</SettingsRow>
				<SettingsRow title="Credits start again" :description="`Every day at midnight UTC. That's ${resetTime()} where you are.`">
					<span class="whitespace-nowrap text-base text-ink-gray-7">Midnight UTC</span>
				</SettingsRow>
			</div>
		</section>

		<section class="space-y-2">
			<h2 class="text-lg-semibold text-ink-gray-8">Admins</h2>
			<p class="text-p-sm text-ink-gray-5">
				Admins can open this page and change these settings. Make someone an admin from their page in People, or on the server with:
			</p>
			<code class="block overflow-x-auto whitespace-nowrap rounded-4 bg-surface-gray-2 px-2 py-1.5 text-sm text-ink-gray-7"
				>npx tsx scripts/admin.ts grant &lt;email&gt;</code
			>
			<ul class="divide-y divide-outline-gray-1">
				<li v-for="admin in admins" :key="admin.id">
					<RouterLink :to="`/people/${encodeURIComponent(admin.id)}`" class="flex items-center gap-3 rounded-4 py-2.5 hover:bg-surface-gray-1">
						<Avatar :label="admin.name" size="md" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-base text-ink-gray-8">{{ admin.name }}</span>
							<span class="block truncate text-sm text-ink-gray-5">{{ admin.email }}</span>
						</span>
						<span class="lucide-chevron-right size-4 text-ink-gray-4" aria-hidden="true" />
					</RouterLink>
				</li>
			</ul>
		</section>
	</div>
</template>
