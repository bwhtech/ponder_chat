<script setup lang="ts">
import { Button, Dialog, FormControl, Radio, RadioGroup, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { admin, unwrap, type Person } from "../api";
import { credits, creditValue } from "../lib/format";
import { settings } from "../store";

/** Set one person's daily credits: the default, or their own number. For an invite, the limit they start with. */
const props = defineProps<{ person: Person | null }>();
const emit = defineEmits<{ saved: [] }>();
const open = defineModel<boolean>("open", { default: false });

const choice = ref<"default" | "custom">("default");
const amount = ref("");
const saving = ref(false);

watch(open, (isOpen) => {
	if (!isOpen || !props.person) return;
	choice.value = props.person.dailyCredits === null ? "default" : "custom";
	amount.value = String(props.person.dailyCredits ?? settings.defaultDailyCredits);
});

const error = computed(() => {
	if (choice.value !== "custom") return "";
	const n = Number(amount.value);
	return amount.value !== "" && Number.isInteger(n) && n >= 0 ? "" : "Enter a whole number, 0 or more.";
});

async function save() {
	const person = props.person;
	if (!person || error.value) return;
	saving.value = true;
	try {
		const credits = choice.value === "default" ? null : Number(amount.value);
		await unwrap(admin.people[":id"]["daily-credits"].$put({ param: { id: encodeURIComponent(person.id) }, json: { credits } }));
		open.value = false;
		toast.success(`Daily credits saved for ${person.name}`);
		emit("saved");
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="`Daily credits for ${person?.name ?? ''}`">
		<div class="space-y-4">
			<!-- frappe-ui 1.0.2 takes the options as <Radio> children (the prototype's 1.1.0 has an options prop). -->
			<RadioGroup v-model="choice" label="Limit">
				<Radio value="default" :label="`Default (${credits(settings.defaultDailyCredits)} a day)`" />
				<Radio value="custom" label="Their own limit" />
			</RadioGroup>
			<FormControl
				v-if="choice === 'custom'"
				v-model="amount"
				type="number"
				label="Credits a day"
				:description="`One credit is ${creditValue(settings.creditsPerUsd)}. The count starts again at midnight UTC.`"
				:error="error"
			/>
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button variant="solid" theme="gray" label="Save" :loading="saving" :disabled="!!error" @click="save" />
			</div>
		</div>
	</Dialog>
</template>
