<script setup lang="ts">
import { Alert, Button, Dialog, Select, Switch, TextInput, toast } from "frappe-ui";
import { computed, ref } from "vue";
import PanelBody from "../settings/PanelBody.vue";
import PanelHeader from "../settings/PanelHeader.vue";
import { settings } from "../settings/state";
import { changeConnector, refreshConnector, RULES, type Connector, type Header, type Rule } from "./api";
import { fullDate, when } from "../dates";
import { confirmRemove, signInAgain } from "./actions";
import ConnectorAvatar from "./ConnectorAvatar.vue";
import HeadersInput from "./HeadersInput.vue";
import ToolRuleRow from "./ToolRuleRow.vue";

/** One connector: on or off, its sign-in, a rule for each tool, and its details. */
const props = defineProps<{ connector: Connector }>();
const c = computed(() => props.connector);
const back = () => (settings.connector = null);

const counts = computed(() => ({
	allow: c.value.tools.filter((tool) => tool.rule === "allow").length,
	ask: c.value.tools.filter((tool) => tool.rule === "ask").length,
	off: c.value.tools.filter((tool) => tool.rule === "off").length,
}));

const query = ref("");
const shown = computed(() => {
	const words = query.value.trim().toLowerCase();
	if (!words) return c.value.tools;
	return c.value.tools.filter((tool) => `${tool.title ?? ""} ${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(words));
});

const enabled = computed({
	get: () => c.value.enabled,
	set: (value: boolean) => void save({ enabled: value }),
});

// "Mixed" when the tools have different rules.
const allRule = computed({
	get: () => {
		const rules = new Set(c.value.tools.map((tool) => tool.rule));
		return rules.size === 1 ? [...rules][0]! : null;
	},
	set: (value: Rule | null) => {
		if (value) void save({ rules: Object.fromEntries(c.value.tools.map((tool) => [tool.name, value])) });
	},
});

async function save(change: Parameters<typeof changeConnector>[1]) {
	try {
		await changeConnector(c.value.id, change);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Not saved.");
	}
}

const refreshing = ref(false);
async function refresh() {
	refreshing.value = true;
	try {
		const fresh = await refreshConnector(c.value.id);
		toast.success(`${fresh.name}: ${fresh.tools.length} tools`);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Could not list the tools.");
	} finally {
		refreshing.value = false;
	}
}

async function remove() {
	if (await confirmRemove(c.value)) back();
}

const status = computed(() => {
	if (c.value.status === "needs_sign_in") return "Sign-in ended";
	if (c.value.status === "error") return "Not working";
	return c.value.auth === "oauth" ? "Signed in" : "Connected";
});

const signIn = computed(() => {
	if (c.value.auth === "none") return "None. Anyone with the address can use this server.";
	if (c.value.auth === "headers") return `An API key in the ${c.value.headerNames.join(", ")} header. Saved encrypted; Ponder never shows it again.`;
	if (c.value.oauthClientId) return `OAuth, with your own app (client ID ${c.value.oauthClientId}).`;
	return `OAuth. Ponder registered itself with ${c.value.name}.`;
});

// A new key: the server checks it before it is saved. Each opening of the dialog is a new
// session, so a save from an earlier one does not close or unlock this one.
const keyOpen = ref(false);
const keyRows = ref<Header[]>([]);
const savingKey = ref(false);
let keySession = 0;
function changeKey() {
	keySession++;
	savingKey.value = false;
	keyRows.value = (c.value.headerNames.length ? c.value.headerNames : ["Authorization"]).map((name) => ({ name, value: "" }));
	keyOpen.value = true;
}
async function saveKey() {
	const session = keySession;
	savingKey.value = true;
	try {
		await changeConnector(c.value.id, { headers: keyRows.value });
		// The key was saved either way, so the toast shows; only its own dialog closes.
		toast.success(`Saved. ${c.value.name} accepted the key.`);
		if (session === keySession) keyOpen.value = false;
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "The key was not saved.");
	} finally {
		if (session === keySession) savingKey.value = false;
	}
}

function copyUrl() {
	void navigator.clipboard?.writeText(c.value.url);
	toast.success("Copied the server URL");
}
</script>

<template>
	<PanelHeader>
		<div class="flex w-full items-center gap-2">
			<Button variant="ghost" icon-left="lucide-arrow-left" label="Connectors" class="-ml-2" @click="back" />
		</div>
	</PanelHeader>
	<PanelBody>
		<div class="space-y-6 pb-6 pt-6">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-3">
				<ConnectorAvatar :name="c.name" size="2xl" />
				<div class="min-w-0 flex-1 basis-48 space-y-1">
					<h2 class="truncate text-xl-semibold text-ink-gray-9">{{ c.name }}</h2>
					<p class="text-p-sm text-ink-gray-6">{{ c.host }} · {{ status }} · {{ c.toolsCheckedAt ? `Tools checked ${when(c.toolsCheckedAt)}` : "Tools never checked" }}</p>
				</div>
				<Switch v-model="enabled" label="Use in chats" :disabled="c.status !== 'connected'" />
			</div>

			<Alert
				v-if="c.status === 'needs_sign_in'"
				theme="amber"
				title="Sign in again"
				:description="c.lastError ?? `${c.name} ended the sign-in.`"
				:primary-action="{ label: 'Sign in', onClick: () => signInAgain(c) }"
			/>
			<Alert
				v-else-if="c.status === 'error'"
				theme="red"
				:title="`${c.name} is not working`"
				:description="c.lastError ?? ''"
				:primary-action="c.auth === 'headers' ? { label: 'Enter a new key', onClick: changeKey } : { label: 'Try again', onClick: refresh }"
			/>

			<div class="flex flex-wrap gap-2">
				<Button icon-left="lucide-refresh-cw" label="Refresh tools" :loading="refreshing" @click="refresh" />
				<Button v-if="c.auth === 'oauth'" icon-left="lucide-log-in" label="Sign in again" @click="signInAgain(c)" />
				<Button v-if="c.auth === 'headers'" icon-left="lucide-key-round" label="Change API key" @click="changeKey" />
				<Button theme="red" variant="subtle" icon-left="lucide-trash-2" label="Remove" @click="remove" />
			</div>

			<section class="space-y-3 pt-4">
				<div class="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h3 class="text-base-semibold text-ink-gray-9">Tools</h3>
						<p class="text-p-sm text-ink-gray-6">{{ counts.allow }} always allowed · {{ counts.ask }} ask first · {{ counts.off }} off</p>
					</div>
					<div v-if="c.tools.length" class="flex items-center gap-2">
						<span class="text-sm text-ink-gray-5" aria-hidden="true">All tools</span>
						<Select v-model="allRule" :options="RULES" placeholder="Mixed" class="w-40" aria-label="Rule for all tools" />
					</div>
				</div>
				<TextInput v-if="c.tools.length > 8" v-model="query" type="search" placeholder="Search tools" aria-label="Search tools">
					<template #prefix><span class="lucide-search size-4 text-ink-gray-5" aria-hidden="true" /></template>
				</TextInput>
				<div class="divide-y divide-outline-gray-1">
					<ToolRuleRow v-for="tool in shown" :key="tool.name" :connector="c" :tool="tool" />
				</div>
				<p v-if="!c.tools.length" class="py-6 text-center text-p-sm text-ink-gray-6">This server lists no tools.</p>
				<p v-else-if="!shown.length" class="py-6 text-center text-p-sm text-ink-gray-6">No tools match “{{ query }}”.</p>
				<p class="text-p-sm text-ink-gray-5">
					“Read-only” is what {{ c.name }} says about a tool. Ponder uses it only to choose where each tool starts, so check the rules of the tools you rely on.
				</p>
			</section>

			<section class="space-y-2 pt-4">
				<h3 class="text-base-semibold text-ink-gray-8">Details</h3>
				<dl class="divide-y divide-outline-gray-1 text-sm">
					<div class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt class="text-ink-gray-6">Server URL</dt>
						<dd class="flex min-w-0 items-center gap-1">
							<span class="truncate font-mono text-xs text-ink-gray-7" :title="c.url">{{ c.url }}</span>
							<Button variant="ghost" size="sm" icon="lucide-copy" aria-label="Copy the server URL" @click="copyUrl" />
						</dd>
					</div>
					<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt class="text-ink-gray-6">Sign-in</dt>
						<dd class="text-p-sm text-ink-gray-7">{{ signIn }}</dd>
					</div>
					<div v-if="c.serverName" class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt class="text-ink-gray-6">Server</dt>
						<dd class="text-p-sm text-ink-gray-7">{{ c.serverName }}</dd>
					</div>
					<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt class="text-ink-gray-6">Added</dt>
						<dd class="text-p-sm text-ink-gray-7">{{ fullDate(c.createdAt) }}</dd>
					</div>
					<div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt class="text-ink-gray-6">Last used</dt>
						<dd class="text-p-sm text-ink-gray-7">{{ c.lastUsedAt ? when(c.lastUsedAt) : "Never" }}</dd>
					</div>
				</dl>
			</section>
		</div>
	</PanelBody>

	<Dialog v-model:open="keyOpen" :title="`New API key for ${c.name}`" size="md">
		<div class="space-y-4">
			<p class="text-p-sm text-ink-gray-6">Ponder checks the key with {{ c.name }} before it saves it, encrypted.</p>
			<HeadersInput v-model="keyRows" names-fixed />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="keyOpen = false" />
				<Button variant="solid" theme="gray" label="Save" :loading="savingKey" :disabled="!keyRows.every((row) => row.value.trim())" @click="saveKey" />
			</div>
		</div>
	</Dialog>
</template>
