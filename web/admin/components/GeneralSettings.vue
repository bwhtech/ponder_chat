<script setup lang="ts">
import { Avatar, Badge, Button, SettingsRow, Skeleton, Switch, TextInput } from "frappe-ui";
import { computed, ref } from "vue";
import { creditValue, date, resetTime } from "../lib/format";
import type { SettingsForm } from "../lib/settings-form";
import ListSkeleton from "./ListSkeleton.vue";
import OpenRouterKeyDialog from "./OpenRouterKeyDialog.vue";
import EmptyState from "../../EmptyState.vue";

/**
 * The General settings: credits, how PDFs are read, the OpenRouter key and the admins. Save is the parent's,
 * from `form`. Skeletons stand in for the values until they load; if they can't, an alert offers Retry.
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
	<div class="space-y-8 pt-4">
		<EmptyState v-if="form.loadError" icon="lucide-circle-alert" title="The settings could not load" :body="form.loadError" alert>
			<Button label="Try again" @click="form.load" />
		</EmptyState>
		<template v-else>
			<section class="space-y-1">
				<h2 class="text-base-semibold text-ink-gray-9">Credits</h2>
				<div class="divide-y divide-outline-gray-1">
					<SettingsRow title="Default daily credits" description="For each person without their own limit.">
						<Skeleton v-if="form.loading" class="h-7 w-28 rounded-4" />
						<div v-else class="flex flex-col items-end gap-1">
							<TextInput v-model="form.defaultCredits" type="number" class="w-28" aria-label="Default daily credits" />
							<span v-if="form.defaultError && form.saved" class="text-xs text-ink-red-6">{{ form.defaultError }}</span>
						</div>
					</SettingsRow>
					<SettingsRow title="Credits per US dollar" :description="form.loading || form.perUsdError || !(Number(form.perUsd) > 0) ? '' : `1 credit = ${creditValue(Number(form.perUsd))}`">
						<Skeleton v-if="form.loading" class="h-7 w-28 rounded-4" />
						<div v-else class="flex flex-col items-end gap-1">
							<TextInput v-model="form.perUsd" type="number" class="w-28" aria-label="Credits per US dollar" />
							<span v-if="form.perUsdError && form.saved" class="text-xs text-ink-red-6">{{ form.perUsdError }}</span>
						</div>
					</SettingsRow>
					<SettingsRow title="Credits start again" :description="`Every day at midnight UTC. That's ${resetTime()} where you are.`">
						<span class="whitespace-nowrap text-base text-ink-gray-7">Midnight UTC</span>
					</SettingsRow>
				</div>
			</section>

			<section class="space-y-1">
				<h2 class="text-base-semibold text-ink-gray-9">PDFs</h2>
				<SettingsRow
					title="Read PDF text on this server"
					description="Models that can't read PDFs get the text this server took from them, once. Off: OpenRouter parses each PDF on every reply, which costs more but keeps tables and layout better. Models that read PDFs always get the PDF."
				>
					<Skeleton v-if="form.loading" class="h-5 w-8 rounded-full" />
					<Switch
						v-else
						:model-value="form.pdfTextOnServer"
						:disabled="form.savingPdf"
						aria-label="Read PDF text on this server"
						@update:model-value="form.setPdfReading"
					/>
				</SettingsRow>
			</section>

			<section class="space-y-1">
				<h2 class="text-base-semibold text-ink-gray-9">OpenRouter</h2>
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
				<h2 class="text-base-semibold text-ink-gray-9">Admins</h2>
				<p class="text-p-sm text-ink-gray-6">
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
								<span class="block truncate text-sm text-ink-gray-6">{{ admin.email }}</span>
							</span>
							<span class="lucide-chevron-right size-4 text-ink-gray-4" aria-hidden="true" />
						</RouterLink>
					</li>
				</ul>
			</section>
		</template>
	</div>
</template>
