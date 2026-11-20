<script setup lang="ts">
import { Button, SettingsRow, Skeleton, Switch, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import EmptyState from "../../EmptyState.vue";
import { admin, unwrap, type MicrosoftSignIn, type SignInData } from "../api";
import MicrosoftSignInDialog from "./MicrosoftSignInDialog.vue";

/**
 * How people sign in: a switch for each way. Email is on unless turned off, which it can be
 * only while Microsoft works, once this admin signed in with it (server/auth/SignInProviders.ts). Microsoft's switch opens its
 * dialog when it has nothing to run on yet; once on, Configure changes its settings.
 * Skeletons stand in for the switches until they load; if they can't, the error replaces them.
 * `heading` on the phone's Settings page, where the tabs' title is not there.
 */
defineProps<{ heading?: boolean }>();

const data = ref<SignInData | null>(null);
const loadError = ref("");
const dialogOpen = ref(false);
/** The switch was turned on and the dialog asks for what Microsoft needs: the switch shows on till then. */
const turningOn = ref(false);
const savingMicrosoft = ref(false);
const savingEmail = ref(false);

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
const microsoftOn = computed(() => turningOn.value || microsoft.value?.enabled === true);
/** Whether Microsoft has what it needs to run: else turning it on opens the dialog. */
const complete = (settings: MicrosoftSignIn) => settings.hasSecret && !settings.secretUnreadable && settings.tenantId !== "";
const microsoftWorks = computed(() => microsoft.value?.enabled === true && complete(microsoft.value));
const email = computed(() => data.value?.email.enabled);
/** Email can go off: Microsoft works, and this admin signed in with it since its settings were saved. */
const emailCanGoOff = computed(() => microsoftWorks.value && data.value?.email.signedInWithMicrosoft === true);

// Closed without saving: the switch goes back to off.
watch(dialogOpen, (open) => !open && (turningOn.value = false));

const INTRO = "Microsoft 365 work accounts.";

function describe(settings: MicrosoftSignIn) {
	if (!settings.enabled) return INTRO;
	if (settings.secretUnreadable) return "The client secret can't be read, because BETTER_AUTH_SECRET changed. Configure it again.";
	const who = settings.signUps === "everyone" ? "Anyone with these domains gets an account." : "A person still needs an invite.";
	return `For emails of ${settings.allowedDomains.join(", ")}. ${who}`;
}

const emailDescription = computed(() => {
	if (email.value === false) return "Off. People sign in with Microsoft only.";
	if (data.value && !microsoftWorks.value) return "A code and a link by email. Turn on Microsoft to switch this off.";
	if (data.value && !emailCanGoOff.value) return "A code and a link by email. To switch this off, sign in with Microsoft once.";
	return "A code and a link by email.";
});

async function setMicrosoft(on: boolean) {
	const settings = microsoft.value;
	if (!data.value || !settings || savingMicrosoft.value) return;
	// Nothing to run on yet: the dialog asks for it, and its Save turns Microsoft on.
	if (on && !complete(settings)) {
		turningOn.value = true;
		dialogOpen.value = true;
		return;
	}
	savingMicrosoft.value = true;
	const emailBefore = data.value.email.enabled;
	try {
		const { tenantId, clientId, signUps, allowedDomains } = settings;
		const json = { enabled: on, tenantId, clientId, signUps, allowedDomains: [...allowedDomains] };
		const saved = await unwrap(admin["sign-in"].microsoft.$put({ json }), "Sign-in with Microsoft could not be changed. Try again.");
		data.value.microsoft = saved.microsoft;
		data.value.email = saved.email;
		if (on) toast.success("People can sign in with Microsoft");
		else toast.success(!emailBefore && saved.email.enabled ? "Microsoft is off. Sign-in by email is on again." : "Sign-in with Microsoft is off");
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		savingMicrosoft.value = false;
	}
}

async function setEmail(on: boolean) {
	if (!data.value || savingEmail.value) return;
	savingEmail.value = true;
	try {
		const saved = await unwrap(admin["sign-in"].email.$put({ json: { enabled: on } }), "Sign-in by email could not be changed. Try again.");
		data.value.email = saved.email;
		toast.success(saved.email.enabled ? "People can sign in by email" : "Sign-in by email is off");
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		savingEmail.value = false;
	}
}

function saved(next: Pick<SignInData, "microsoft" | "email">) {
	const emailBefore = data.value?.email.enabled;
	if (data.value) Object.assign(data.value, next);
	turningOn.value = false;
	// A change that could stop Microsoft working turns email on again (server/auth/SignInProviders.ts).
	if (emailBefore === false && next.email.enabled) toast.info("Sign-in by email is on again. Sign in with Microsoft to check the change, then switch it off.");
}
</script>

<template>
	<div class="space-y-8 pt-4">
		<EmptyState v-if="loadError" icon="lucide-circle-alert" title="The sign-in settings could not load" :body="loadError" alert>
			<Button label="Try again" @click="load" />
		</EmptyState>
		<section v-else class="space-y-1">
			<h2 v-if="heading" class="text-base-semibold text-ink-gray-9">Sign-in</h2>
			<div class="divide-y divide-outline-gray-1">
				<SettingsRow title="Email" :description="emailDescription">
					<Skeleton v-if="email === undefined" class="h-5 w-8 rounded-full" />
					<Switch
						v-else
						:model-value="email"
						:disabled="savingEmail || (email && !emailCanGoOff)"
						aria-label="Sign in by email"
						@update:model-value="setEmail"
					/>
				</SettingsRow>
				<SettingsRow title="Microsoft" :description="microsoft ? describe(microsoft) : INTRO">
					<Skeleton v-if="!microsoft" class="h-5 w-8 rounded-full" />
					<div v-else class="flex items-center gap-3">
						<Button v-if="microsoft.enabled" class="touch-target" label="Configure" @click="dialogOpen = true" />
						<Switch :model-value="microsoftOn" :disabled="savingMicrosoft" aria-label="Sign in with Microsoft" @update:model-value="setMicrosoft" />
					</div>
				</SettingsRow>
			</div>
			<MicrosoftSignInDialog
				v-if="data"
				v-model:open="dialogOpen"
				:microsoft="data.microsoft"
				:redirect-uris="data.redirectUris"
				:turning-on="turningOn"
				@saved="saved"
			/>
		</section>
	</div>
</template>
