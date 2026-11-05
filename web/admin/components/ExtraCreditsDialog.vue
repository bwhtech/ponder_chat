<script setup lang="ts">
import { Button, Dialog, FormControl, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";

/**
 * Extra credits for today: to approve a request, or to give credits without one.
 * `submit` makes the call, and the dialog closes when it succeeds.
 */
const props = defineProps<{ title: string; confirmLabel: string; suggested: number; submit: (credits: number) => Promise<void> }>();
const open = defineModel<boolean>("open", { default: false });

const amount = ref("");
const saving = ref(false);

watch(open, (isOpen) => {
	if (isOpen) amount.value = String(Math.max(1, props.suggested));
});

const error = computed(() => {
	const n = Number(amount.value);
	return amount.value !== "" && Number.isInteger(n) && n > 0 ? "" : "Enter a whole number above 0.";
});

async function save() {
	if (error.value) return;
	saving.value = true;
	try {
		await props.submit(Number(amount.value));
		open.value = false;
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="title">
		<div class="space-y-4">
			<FormControl
				v-model="amount"
				type="number"
				label="Extra credits for today"
				description="Added to today's limit only. Credits refill at midnight UTC as usual."
				:error="error"
			/>
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button variant="solid" theme="gray" :label="confirmLabel" :loading="saving" :disabled="!!error" @click="save" />
			</div>
		</div>
	</Dialog>
</template>
