<script setup lang="ts">
import { Button, FormControl, Password, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { admin, ApiError, unwrap, type MicrosoftSignIn, type SignInData } from "../api";

/**
 * The settings of sign-in with Microsoft (server/auth/microsoft.ts), in MicrosoftSignInDialog:
 * what to do in Entra beside the fields. Saving turns Microsoft on; the switch on the Sign-in tab
 * turns it off. The server checks the values, and asks Microsoft whether the tenant, the client ID
 * and the secret work, before it saves them; it says which field is wrong. It keeps the client
 * secret encrypted and never sends it back, so that field starts empty; left empty, the saved
 * secret stays. Mounted each time the dialog opens, so it starts from the saved settings.
 */
type SignUps = MicrosoftSignIn["signUps"];
type Field = "tenantId" | "clientId" | "clientSecret" | "domains";

const props = defineProps<{ microsoft: MicrosoftSignIn; redirectUris: string[]; turningOn: boolean }>();
const emit = defineEmits<{ saved: [saved: Pick<SignInData, "microsoft" | "email">]; cancel: [] }>();

const SIGN_UP_OPTIONS: { label: string; value: SignUps }[] = [
	{ label: "Invited people only", value: "invited" },
	{ label: "Anyone with these email domains", value: "everyone" },
];

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
	"tenant-unknown": "tenantId",
	"client-id-unknown": "clientId",
	"client-secret-wrong": "clientSecret",
	"client-secret-expired": "clientSecret",
};

const tenantId = ref(props.microsoft.tenantId);
const clientId = ref(props.microsoft.clientId);
const clientSecret = ref("");
const domains = ref(props.microsoft.allowedDomains.join(", "));
const signUps = ref<SignUps>(props.microsoft.signUps);
const saving = ref(false);
/** The server's message for the field it refused. */
const problem = ref<{ field: Field; message: string } | null>(null);
watch([tenantId, clientId, clientSecret, domains], () => (problem.value = null));

const errorOf = (field: Field) => (problem.value?.field === field ? problem.value.message : undefined);
const secretHelp = computed(() => {
	if (props.microsoft.secretUnreadable) return "The saved secret can't be read. Enter it again.";
	if (props.microsoft.hasSecret) return "Saved. Leave empty to keep it.";
	return "Its Value, not its ID.";
});

/** Domains as typed: with commas, spaces or lines between them. */
const domainsOf = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

async function save() {
	if (saving.value) return;
	saving.value = true;
	problem.value = null;
	try {
		const json = {
			enabled: true,
			tenantId: tenantId.value,
			clientId: clientId.value,
			signUps: signUps.value,
			allowedDomains: domainsOf(domains.value),
			...(clientSecret.value.trim() && { clientSecret: clientSecret.value.trim() }),
		};
		emit("saved", await unwrap(admin["sign-in"].microsoft.$put({ json }), "The sign-in settings could not be saved. Try again."));
		toast.success(props.turningOn ? "Microsoft accepted the settings. People can sign in with it." : "Microsoft accepted the settings");
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
	<form class="grid gap-x-6 gap-y-5 md:grid-cols-[16rem_minmax(0,1fr)]" @submit.prevent="save">
		<!-- What to do in Entra, beside the fields it gives. -->
		<aside class="space-y-3 rounded-7 bg-surface-gray-1 p-4 md:self-start dark:bg-surface-gray-2" aria-label="In Microsoft Entra">
			<a href="https://entra.microsoft.com" target="_blank" rel="noreferrer" class="flex items-center gap-1 text-base-medium text-ink-gray-8 hover:underline">
				In Microsoft Entra
				<span class="lucide-arrow-up-right size-3.5 text-ink-gray-5" aria-hidden="true" />
			</a>
			<ol class="list-decimal space-y-2 pl-4 text-p-sm text-ink-gray-6 marker:text-ink-gray-5">
				<li>Register an app, for this directory only.</li>
				<li>
					Add {{ redirectUris.length > 1 ? "these redirect URIs" : "this redirect URI" }}, as Web:
					<span v-for="uri in redirectUris" :key="uri" class="mt-1.5 flex items-start gap-1 rounded-4 bg-surface-elevation-1 py-1 pl-2 pr-1 dark:bg-surface-gray-3">
						<!-- Lines break after a slash of the path, not inside a word. -->
						<span class="min-w-0 flex-1 py-0.5 font-mono [overflow-wrap:anywhere] text-xs text-ink-gray-7" data-slot="redirect-uri"><template v-for="(part, index) in uri.split(/(?<=[^:/]\/)/)" :key="index">{{ part }}<wbr /></template></span>
						<Button variant="ghost" size="sm" icon="lucide-copy" class="touch-target shrink-0" aria-label="Copy the redirect URI" @click="copy(uri)" />
					</span>
				</li>
				<li>Make a client secret.</li>
			</ol>
		</aside>

		<div class="space-y-4">
			<FormControl v-model="tenantId" label="Directory (tenant) ID" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" spellcheck="false" :error="errorOf('tenantId')" />
			<FormControl v-model="clientId" label="Application (client) ID" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off" spellcheck="false" :error="errorOf('clientId')" />
			<Password v-model="clientSecret" label="Client secret" autocomplete="off" :description="secretHelp" :error="errorOf('clientSecret')" />
			<FormControl v-model="domains" label="Email domains" placeholder="example.org, example.com" autocomplete="off" spellcheck="false" :error="errorOf('domains')" />
			<FormControl v-model="signUps" type="select" label="New accounts" :options="SIGN_UP_OPTIONS" />
		</div>

		<div class="flex gap-2 md:col-span-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
			<Button class="touch-target" label="Cancel" @click="emit('cancel')" />
			<Button type="submit" class="touch-target" variant="solid" theme="gray" :label="saving ? 'Checking with Microsoft' : turningOn ? 'Turn on' : 'Save'" :loading="saving" />
		</div>
	</form>
</template>
