<script setup lang="ts">
import { Button, Dialog, FormControl, Password, Switch, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { admin, ApiError, unwrap, type MicrosoftSignIn } from "../api";

/**
 * Set up sign-in with Microsoft, or change it (server/auth/microsoft.ts). Everything saves
 * together: sign-in is on only when all of it is right. The server checks the values and
 * says which field is wrong. It keeps the client secret encrypted and never sends it back,
 * so that field starts empty; left empty, the saved secret stays.
 */
type SignUps = MicrosoftSignIn["signUps"];
type Field = "tenantId" | "clientId" | "clientSecret" | "domains";

const props = defineProps<{ microsoft: MicrosoftSignIn; redirectUris: string[] }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [microsoft: MicrosoftSignIn] }>();

const SIGN_UP_OPTIONS: { label: string; value: SignUps }[] = [
	{ label: "Invited people only", value: "invited" },
	{ label: "Everyone in the organisation", value: "everyone" },
];
const SIGN_UP_HELP: Record<SignUps, string> = {
	invited: "A person needs an invite, as for sign-in by email.",
	everyone: "Each person with an email of these domains gets an account at their first sign-in, with no invite.",
};

/** The field each of the server's problems is about (InvalidSettings in server/auth/microsoft.ts). */
const FIELD_OF: Record<string, Field> = {
	tenant: "tenantId",
	"tenant-format": "tenantId",
	"client-id": "clientId",
	"client-id-format": "clientId",
	"client-secret": "clientSecret",
	"secret-is-id": "clientSecret",
	domains: "domains",
	"domain-format": "domains",
};

const enabled = ref(false);
const tenantId = ref("");
const clientId = ref("");
const clientSecret = ref("");
const domains = ref("");
const signUps = ref<SignUps>("invited");
const saving = ref(false);
/** The server's message for the field it refused. */
const problem = ref<{ field: Field; message: string } | null>(null);

watch(open, (isOpen) => {
	if (!isOpen) return;
	// The first time, the dialog is for turning it on.
	enabled.value = props.microsoft.updatedAt === null ? true : props.microsoft.enabled;
	tenantId.value = props.microsoft.tenantId;
	clientId.value = props.microsoft.clientId;
	clientSecret.value = "";
	domains.value = props.microsoft.allowedDomains.join("\n");
	signUps.value = props.microsoft.signUps;
	problem.value = null;
});
watch([tenantId, clientId, clientSecret, domains], () => (problem.value = null));

const errorOf = (field: Field) => (problem.value?.field === field ? problem.value.message : undefined);
const secretHelp = computed(() => {
	if (props.microsoft.secretUnreadable) return "The saved secret can't be read. Enter the secret's Value again, or make a new secret in Entra.";
	if (props.microsoft.hasSecret) return "A secret is saved, encrypted. Leave this empty to keep it.";
	return "The secret's Value, from Certificates & secrets. Entra shows it once. Ponder saves it encrypted.";
});

/** Domains as typed: one on each line, or with commas or spaces between them. */
const domainsOf = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

async function save() {
	if (saving.value) return;
	saving.value = true;
	problem.value = null;
	try {
		const json = {
			enabled: enabled.value,
			tenantId: tenantId.value,
			clientId: clientId.value,
			signUps: signUps.value,
			allowedDomains: domainsOf(domains.value),
			...(clientSecret.value.trim() && { clientSecret: clientSecret.value.trim() }),
		};
		const { microsoft } = await unwrap(admin["sign-in"].microsoft.$put({ json }), "The sign-in settings could not be saved. Try again.");
		emit("saved", microsoft);
		open.value = false;
		toast.success(microsoft.enabled ? "People can sign in with Microsoft" : "Sign-in with Microsoft is off");
	} catch (e) {
		const field = e instanceof ApiError ? FIELD_OF[e.errors[0] ?? ""] : undefined;
		if (field) problem.value = { field, message: (e as Error).message };
		else toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}

function copy(uri: string) {
	void navigator.clipboard?.writeText(uri);
	toast.success("Copied the redirect URI");
}
</script>

<template>
	<Dialog v-model:open="open" title="Sign in with Microsoft" size="lg">
		<form class="space-y-4" @submit.prevent="save">
			<div class="space-y-2">
				<p class="text-p-sm text-ink-gray-6">
					In the
					<a href="https://entra.microsoft.com" target="_blank" rel="noreferrer" class="text-ink-gray-7 underline">Microsoft Entra admin center</a>, register an app for
					Ponder Chat: App registrations, then New registration. Choose accounts in this organisational directory only, and add
					{{ redirectUris.length > 1 ? "these redirect URIs" : "this redirect URI" }}, of type Web:
				</p>
				<div v-for="uri in redirectUris" :key="uri" class="flex items-center gap-1 rounded-4 bg-surface-gray-1 px-2.5 py-1.5">
					<span class="min-w-0 flex-1 truncate font-mono text-xs text-ink-gray-7" data-slot="redirect-uri">{{ uri }}</span>
					<Button variant="ghost" size="sm" icon="lucide-copy" class="touch-target" aria-label="Copy the redirect URI" @click="copy(uri)" />
				</div>
			</div>
			<FormControl
				v-model="tenantId"
				label="Directory (tenant) ID"
				placeholder="00000000-0000-0000-0000-000000000000"
				description="On the app's Overview page, with the client ID. Only accounts of this directory sign in."
				autocomplete="off"
				spellcheck="false"
				:error="errorOf('tenantId')"
			/>
			<FormControl
				v-model="clientId"
				label="Application (client) ID"
				placeholder="00000000-0000-0000-0000-000000000000"
				autocomplete="off"
				spellcheck="false"
				:error="errorOf('clientId')"
			/>
			<Password v-model="clientSecret" label="Client secret" autocomplete="off" :description="secretHelp" :error="errorOf('clientSecret')" />
			<FormControl
				v-model="domains"
				type="textarea"
				label="Email domains"
				placeholder="example.org"
				description="Your organisation's email domains, one on each line. Only people with an email of these domains sign in with Microsoft."
				:rows="2"
				spellcheck="false"
				:error="errorOf('domains')"
			/>
			<FormControl v-model="signUps" type="select" label="New accounts" :options="SIGN_UP_OPTIONS" :description="SIGN_UP_HELP[signUps]" />
			<Switch v-model="enabled" label="People can sign in with Microsoft" description="The sign-in page shows the button. Sign-in by email stays on." />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" label="Save" :loading="saving" />
			</div>
		</form>
	</Dialog>
</template>
