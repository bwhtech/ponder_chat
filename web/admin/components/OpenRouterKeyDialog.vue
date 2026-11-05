<script setup lang="ts">
import { Button, Dialog, Password, toast } from "frappe-ui";
import { ref, watch } from "vue";
import { api, type KeyStatus } from "../api";

/**
 * Add or change the OpenRouter key. The server checks the key with OpenRouter before it
 * saves it encrypted, and never sends it back, so the field starts empty.
 */
defineProps<{ title: string }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [status: KeyStatus] }>();

const key = ref("");
const error = ref("");
const saving = ref(false);

watch(open, (isOpen) => {
	if (!isOpen) return;
	key.value = "";
	error.value = "";
});
watch(key, () => (error.value = ""));

async function save() {
	if (!key.value.trim() || saving.value) return;
	saving.value = true;
	try {
		emit("saved", await api<KeyStatus>("/settings/openrouter-key", { method: "PUT", body: { key: key.value.trim() } }));
		open.value = false;
		toast.success("OpenRouter key saved");
	} catch (e) {
		error.value = (e as Error).message;
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="title">
		<form class="space-y-4" @submit.prevent="save">
			<Password
				v-model="key"
				label="API key"
				placeholder="sk-or-v1-…"
				autocomplete="off"
				:error="error"
				description="Replies, chat names, memory and web search all use this key. Ponder checks it with OpenRouter, then saves it encrypted."
			/>
			<p class="text-p-sm text-ink-gray-5">
				Make a key at
				<a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer" class="text-ink-gray-7 underline">openrouter.ai/settings/keys</a>.
			</p>
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :label="saving ? 'Checking…' : 'Save key'" :loading="saving" :disabled="!key.trim()" />
			</div>
		</form>
	</Dialog>
</template>
