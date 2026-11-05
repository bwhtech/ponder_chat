<script setup lang="ts">
import { Button, Checkbox, Dialog, FormControl, toast } from "frappe-ui";
import { computed, ref } from "vue";
import { api } from "../api";
import { settings } from "../store";

/** Invite people: adds them to the invite list, and optionally emails them that they can sign in. */
const props = defineProps<{ taken: string[] }>();
const emit = defineEmits<{ invited: [] }>();
const open = defineModel<boolean>("open", { default: false });

const emails = ref("");
const note = ref("");
const dailyCredits = ref("");
const sendEmail = ref(true);
const saving = ref(false);

const parsed = computed(() => [
	...new Set(
		emails.value
			.split(/[\s,;]+/)
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	),
]);
const invalid = computed(() => parsed.value.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)));
const already = computed(() => parsed.value.filter((e) => props.taken.includes(e)));
const emailError = computed(() => {
	if (invalid.value.length) return `Not an email address: ${invalid.value.join(", ")}`;
	if (already.value.length) return `Already invited: ${already.value.join(", ")}`;
	return "";
});
const creditsError = computed(() => {
	if (!dailyCredits.value) return "";
	const n = Number(dailyCredits.value);
	return Number.isInteger(n) && n >= 0 ? "" : "Enter a whole number, or leave it empty.";
});
const canInvite = computed(() => parsed.value.length > 0 && !emailError.value && !creditsError.value);

async function invite() {
	if (!canInvite.value) return;
	saving.value = true;
	try {
		const body = {
			emails: parsed.value,
			note: note.value.trim(),
			dailyCredits: dailyCredits.value ? Number(dailyCredits.value) : null,
			sendEmail: sendEmail.value,
		};
		const result = await api<{ invited: number; notSent: string[] }>("/invites", { body });
		toast.success(result.invited === 1 ? `Invited ${parsed.value[0]}` : `Invited ${result.invited} people`);
		if (result.notSent.length) toast.warning(`The email could not be sent to ${result.notSent.join(", ")}`);
		emails.value = "";
		note.value = "";
		dailyCredits.value = "";
		open.value = false;
		emit("invited");
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" title="Invite people">
		<div class="space-y-4">
			<FormControl
				v-model="emails"
				type="textarea"
				label="Emails"
				description="One per line, or separated by commas."
				:rows="4"
				:error="emailError"
				required
			/>
			<FormControl v-model="note" label="Note" description="Shown in the people list, such as their organisation or group." />
			<FormControl
				v-model="dailyCredits"
				type="number"
				label="Daily credits"
				:description="`Leave empty to use the default, ${settings.defaultDailyCredits} a day.`"
				:error="creditsError"
			/>
			<Checkbox v-model="sendEmail" label="Email them that they can sign in" />
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button
					variant="solid"
					theme="gray"
					:label="parsed.length > 1 ? `Invite ${parsed.length} people` : 'Invite'"
					:loading="saving"
					:disabled="!canInvite"
					@click="invite"
				/>
			</div>
		</div>
	</Dialog>
</template>
