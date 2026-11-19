<script setup lang="ts">
import { Badge, Button, SettingsRow, Skeleton } from "frappe-ui";
import { computed, ref } from "vue";
import EmptyState from "../../EmptyState.vue";
import { admin, unwrap, type MicrosoftSignIn, type SignInData } from "../api";
import MicrosoftSignInDialog from "./MicrosoftSignInDialog.vue";

/**
 * How people sign in: by email, always, and with Microsoft once it is set up here
 * (server/auth/microsoft.ts). The row says how Microsoft is set; its dialog changes it.
 * Skeletons stand in for the values until they load; if they can't, the error replaces them.
 */
const data = ref<SignInData | null>(null);
const loadError = ref("");
const setupOpen = ref(false);

async function load() {
	loadError.value = "";
	data.value = null;
	try {
		data.value = await unwrap(admin["sign-in"].$get());
	} catch (e) {
		loadError.value = (e as Error).message;
	}
}
void load();

const microsoft = computed(() => data.value?.microsoft);
const isNew = computed(() => microsoft.value?.updatedAt === null);

/** What Microsoft sign-in is, for the row before it is set up. It also stands there while the settings load, so the row keeps its height. */
const INTRO = "People of your organisation sign in with their Microsoft 365 work accounts.";

function describe(microsoft: MicrosoftSignIn) {
	if (microsoft.updatedAt === null) return INTRO;
	if (microsoft.secretUnreadable) return "The saved client secret can't be read, because BETTER_AUTH_SECRET changed on the server. Enter the secret again.";
	if (!microsoft.enabled) return "Off. The settings are kept, so you can turn it on again.";
	const who = microsoft.signUps === "everyone" ? "Everyone with such an email gets an account." : "A person still needs an invite.";
	return `For emails of ${microsoft.allowedDomains.join(", ")}. ${who}`;
}
</script>

<template>
	<div class="space-y-8 pt-4">
		<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The sign-in settings could not load" :body="loadError" alert>
			<Button label="Try again" @click="load" />
		</EmptyState>
		<section v-else class="space-y-1">
			<h2 class="text-base-semibold text-ink-gray-9">Ways to sign in</h2>
			<div class="divide-y divide-outline-gray-1">
				<SettingsRow title="Email" description="A code and a link by email, for people you invite. No passwords.">
					<span class="whitespace-nowrap text-base text-ink-gray-7">Always on</span>
				</SettingsRow>
				<SettingsRow title="Microsoft" :description="microsoft ? describe(microsoft) : INTRO">
					<Skeleton v-if="!microsoft" class="h-7 w-24 rounded-4" />
					<div v-else class="flex items-center gap-3">
						<Badge v-if="microsoft.secretUnreadable" theme="red" label="Can't be read" />
						<Badge v-else-if="!isNew" :theme="microsoft.enabled ? 'green' : 'gray'" :label="microsoft.enabled ? 'On' : 'Off'" />
						<Button class="touch-target" :label="isNew ? 'Set up' : 'Change'" @click="setupOpen = true" />
					</div>
				</SettingsRow>
			</div>
			<MicrosoftSignInDialog
				v-if="data"
				v-model:open="setupOpen"
				:microsoft="data.microsoft"
				:redirect-uris="data.redirectUris"
				@saved="(next) => data && (data.microsoft = next)"
			/>
		</section>
	</div>
</template>
