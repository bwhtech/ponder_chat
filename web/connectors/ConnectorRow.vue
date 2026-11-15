<script setup lang="ts">
import { Button, Dropdown, Switch } from "frappe-ui";
import { toast } from "../toasts";
import { computed } from "vue";
import { settings } from "../settings/state";
import { changeConnector, refreshConnector, type Connector } from "./api";
import { confirmRemove, signInAgain } from "./actions";
import ConnectorAvatar from "./ConnectorAvatar.vue";

const props = defineProps<{ connector: Connector }>();
const c = computed(() => props.connector);
const open = () => (settings.connector = c.value.id);

const meta = computed(() => {
	if (c.value.status === "needs_sign_in") return { text: `Sign-in ended · ${c.value.host}`, tone: "text-ink-amber-6" };
	if (c.value.status === "error") return { text: `${c.value.lastError ?? "Not working"} · ${c.value.host}`, tone: "text-ink-red-6" };
	if (!c.value.enabled) return { text: `Off · ${c.value.host}`, tone: "text-ink-gray-5" };
	const on = c.value.tools.filter((tool) => tool.rule !== "off").length;
	return { text: `${c.value.host} · ${on} of ${c.value.tools.length} tools on`, tone: "text-ink-gray-6" };
});

const enabled = computed({
	get: () => c.value.enabled,
	set: (value: boolean) => void setEnabled(value),
});

async function setEnabled(value: boolean) {
	try {
		await changeConnector(c.value.id, { enabled: value });
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Not saved.");
	}
}

async function refresh() {
	try {
		const fresh = await refreshConnector(c.value.id);
		toast.success(`${fresh.name}: ${fresh.tools.length} tools`);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "Could not list the tools.");
	}
}

const menu = computed(() => [
	{ label: "Open", icon: "lucide-settings-2", onClick: open },
	{ label: "Refresh tools", icon: "lucide-refresh-cw", onClick: refresh },
	...(c.value.auth === "oauth" ? [{ label: "Sign in again", icon: "lucide-log-in", onClick: () => signInAgain(c.value) }] : []),
	{ label: "Remove", icon: "lucide-trash-2", theme: "red" as const, onClick: () => confirmRemove(c.value) },
]);
</script>

<template>
	<div class="flex items-center gap-3 py-3">
		<button type="button" class="flex min-w-0 flex-1 items-center gap-3 rounded-4 text-left" :aria-label="`Open ${c.name}`" @click="open">
			<ConnectorAvatar :name="c.name" />
			<div class="min-w-0 flex-1">
				<p class="truncate text-base-medium text-ink-gray-8">{{ c.name }}</p>
				<p class="truncate text-sm" :class="meta.tone" :title="meta.text">{{ meta.text }}</p>
			</div>
		</button>
		<div class="flex shrink-0 items-center gap-1.5">
			<Button v-if="c.status === 'needs_sign_in'" size="sm" label="Sign in again" @click="signInAgain(c)" />
			<Button v-else-if="c.status === 'error'" size="sm" label="Fix" @click="open" />
			<Switch v-else v-model="enabled" :aria-label="`Use ${c.name} in chats`" />
			<Dropdown :options="menu" align="end">
				<Button variant="ghost" icon="lucide-ellipsis" :aria-label="`Actions for ${c.name}`" />
			</Dropdown>
		</div>
	</div>
</template>
