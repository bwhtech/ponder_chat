<script setup lang="ts">
import { Button, Dialog, FormControl, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { checkDetails, MAX_DESCRIPTION, toSkillName } from "../../../shared/skill-file";
import { admin, unwrap, type SkillDetail } from "../api";

/**
 * New skill: a name and a description, then the editor opens for the instructions. The
 * skill starts off, so no one gets it before it has instructions. With `from`, it is a
 * copy of that skill: its description, instructions and kind come along.
 */
const props = defineProps<{ from?: SkillDetail | null }>();
const open = defineModel<boolean>("open", { default: false });
const router = useRouter();

const name = ref("");
const description = ref("");
const touched = ref(false);
const saving = ref(false);

watch(open, (isOpen) => {
	if (!isOpen) return;
	name.value = props.from ? `${props.from.name}-copy` : "";
	description.value = props.from?.description ?? "";
	touched.value = false;
});

// Typed as words, kept as a name: "Meeting Notes" becomes "meeting-notes".
watch(name, (typed) => {
	const cleaned = toSkillName(typed);
	if (cleaned !== typed) name.value = cleaned;
});

const errors = computed(() => checkDetails({ name: name.value.replace(/-$/, ""), description: description.value }));
const nameError = computed(() => (touched.value ? (errors.value.find((e) => e.includes("name")) ?? "") : ""));
const descriptionError = computed(() => (touched.value ? (errors.value.find((e) => e.includes("description")) ?? "") : ""));

async function create() {
	touched.value = true;
	name.value = name.value.replace(/^-+|-+$/g, "");
	if (errors.value.length) return;
	saving.value = true;
	try {
		const from = props.from;
		const skill = await unwrap(
			admin.skills.$post({
				json: { name: name.value, description: description.value, automatic: from?.automatic ?? true, body: from?.body ?? "", enabled: false },
			}),
		);
		open.value = false;
		await router.push(`/skills/${skill.id}`);
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="from ? 'Duplicate skill' : 'New skill'">
		<form class="space-y-4" @submit.prevent="create">
			<FormControl
				v-model="name"
				label="Name"
				placeholder="meeting-notes"
				required
				autocomplete="off"
				:description="`People type $${name || 'name'} to use it. Lowercase letters, numbers and hyphens.`"
				:error="nameError"
			/>
			<FormControl
				v-model="description"
				type="textarea"
				label="Description"
				placeholder="Turn a meeting transcript into decisions, owners and dates."
				required
				:rows="3"
				:description="`What the skill is for. Ponder reads it to decide when to use the skill. ${description.length} of ${MAX_DESCRIPTION} characters.`"
				:error="descriptionError"
			/>
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :label="from ? 'Duplicate' : 'Create'" :loading="saving" />
			</div>
		</form>
	</Dialog>
</template>
