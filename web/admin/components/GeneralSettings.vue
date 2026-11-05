<script setup lang="ts">
import { Avatar, Badge, Button, SettingsRow, Skeleton, TextInput } from "frappe-ui";
import { computed, ref } from "vue";
import { creditValue, date, resetTime } from "../lib/format";
import type { SettingsForm } from "../lib/settings-form";
import ListSkeleton from "./ListSkeleton.vue";
import OpenRouterKeyDialog from "./OpenRouterKeyDialog.vue";

/**
 * The General settings: credits, the OpenRouter key and the admins. Save is the parent's,
 * from `form`. Skeletons stand in for the values until they load.
 */
const props = defineProps<{ form: SettingsForm }>();

const keyOpen = ref(false);
const key = computed(() => props.form.openRouterKey);
const keyMissing = computed(() => key.value?.source === "none" || key.value?.unreadable);
const keyText = computed(() => {
	if (!key.value) return "";
	if (key.value.source === "none") return "There is no key, so replies don't work. Add one.";
	if (key.value.unreadable) return "The saved key can't be read, because BETTER_AUTH_SECRET changed on the server. Enter the key again.";
	if (key.value.source === "environment") return "From OPENROUTER_API_KEY on the server. A key saved here replaces it.";
	return `Saved here, encrypted. Changed by ${key.value.updatedBy ?? "an admin"} on ${date(key.value.updatedAt)}.`;
});
</script>

<template>
	<div class="space-y-10 pt-4">
		<section class="space-y-1">
			<h2 class="text-base-semibold text-ink-gray-8">Credits</h2>
			<div class="divide-y divide-outline-gray-1">
				<SettingsRow title="Default daily credits" description="For each person without their own limit.">
					<Skeleton v-if="form.loading" class="h-7 w-28 rounded-4" />
					<div v-else class="flex flex-col items-end gap-1">
						<TextInput v-model="form.defaultCredits" type="number" class="w-28" aria-label="Default daily credits" />
						<span v-if="form.defaultError && form.saved" class="text-xs text-ink-red-5">{{ form.defaultError }}</span>
					</div>
				</SettingsRow>
				<SettingsRow title="Credits per US dollar" :description="form.loading || form.perUsdError ? '' : `1 credit = ${creditValue(Number(form.perUsd))}`">
					<Skeleton v-if="form.loading" class="h-7 w-28 rounded-4" />
					<div v-else class="flex flex-col items-end gap-1">
						<TextInput v-model="form.perUsd" type="number" class="w-28" aria-label="Credits per US dollar" />
						<span v-if="form.perUsdError && form.saved" class="text-xs text-ink-red-5">{{ form.perUsdError }}</span>
					</div>
				</SettingsRow>
				<SettingsRow title="Credits start again" :description="`Every day at midnight UTC. That's ${resetTime()} where you are.`">
					<span class="whitespace-nowrap text-base text-ink-gray-7">Midnight UTC</span>
				</SettingsRow>
			</div>
		</section>

		<section class="space-y-1">
			<h2 class="text-base-semibold text-ink-gray-8">OpenRouter</h2>
			<SettingsRow title="API key" :description="keyText">
				<Skeleton v-if="form.loading" class="h-7 w-32 rounded-4" />
				<div v-else-if="key" class="flex items-center gap-3">
					<Badge v-if="keyMissing" theme="red" :label="key.unreadable ? 'Can\'t be read' : 'Missing'" />
					<code v-else-if="key.hint" class="text-sm text-ink-gray-6">{{ key.hint }}</code>
					<Button :label="key.source === 'none' ? 'Add key' : 'Change'" @click="keyOpen = true" />
				</div>
			</SettingsRow>
			<OpenRouterKeyDialog
				v-model:open="keyOpen"
				:title="key?.source === 'none' ? 'Add the OpenRouter key' : 'Change the OpenRouter key'"
				@saved="(status) => (form.openRouterKey = status)"
			/>
		</section>

		<section class="space-y-2">
			<h2 class="text-base-semibold text-ink-gray-8">Admins</h2>
			<p class="text-p-sm text-ink-gray-5">
				Admins can open /admin and change these settings. Make someone an admin from their page in People, or on the server with:
			</p>
			<code class="block overflow-x-auto whitespace-nowrap rounded-4 bg-surface-gray-2 px-2 py-1.5 text-sm text-ink-gray-7"
				>npx tsx scripts/admin.ts grant &lt;email&gt;</code
			>
			<ListSkeleton v-if="form.loading" :rows="2" two-lines label="Loading admins" />
			<ul v-else class="divide-y divide-outline-gray-1">
				<li v-for="admin in form.admins" :key="admin.id">
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
