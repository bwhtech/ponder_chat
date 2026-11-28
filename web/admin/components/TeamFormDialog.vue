<script setup lang="ts">
import { Avatar, Button, Dialog, FormControl, toast } from "frappe-ui";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { displayName } from "../../../shared/display-name";
import { admin, unwrap, type PersonFound, type TeamDetail } from "../api";
import PersonSearch from "./PersonSearch.vue";

/**
 * New team: a name, a description and the first team admin, then the team's page opens.
 * With `team`, it edits that team's name and description instead.
 */
const props = defineProps<{ team?: TeamDetail | null }>();
const emit = defineEmits<{ saved: [team: TeamDetail] }>();
const open = defineModel<boolean>("open", { default: false });
const router = useRouter();

const MAX_NAME = 80;
const name = ref("");
const description = ref("");
const firstAdmin = ref<PersonFound | null>(null);
const touched = ref(false);
const saving = ref(false);

watch(open, (isOpen) => {
	if (!isOpen) return;
	name.value = props.team?.name ?? "";
	description.value = props.team?.description ?? "";
	firstAdmin.value = null;
	touched.value = false;
});

const nameError = computed(() => {
	if (!touched.value) return "";
	if (!name.value.trim()) return "Give the team a name.";
	return name.value.trim().length > MAX_NAME ? `At most ${MAX_NAME} characters.` : "";
});
const adminError = computed(() => (touched.value && !props.team && !firstAdmin.value ? "Pick the person who manages the team." : ""));

async function save() {
	touched.value = true;
	if (nameError.value || adminError.value) return;
	saving.value = true;
	try {
		const fields = { name: name.value.trim(), description: description.value.trim() };
		if (props.team) {
			const { team } = await unwrap(admin.teams[":id"].$patch({ param: { id: encodeURIComponent(props.team.id) }, json: fields }));
			emit("saved", team);
			open.value = false;
			return;
		}
		const { team } = await unwrap(admin.teams.$post({ json: { ...fields, adminUserId: firstAdmin.value?.id ?? "" } }));
		open.value = false;
		await router.push(`/teams/${encodeURIComponent(team.id)}`);
	} catch (e) {
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<Dialog v-model:open="open" :title="team ? 'Edit team' : 'New team'">
		<form class="space-y-4" @submit.prevent="save">
			<FormControl v-model="name" label="Name" placeholder="HR" required autocomplete="off" :maxlength="MAX_NAME" :error="nameError" />
			<FormControl v-model="description" type="textarea" label="Description" placeholder="People, pay and leave." :rows="2" :maxlength="500" />
			<div v-if="!team" class="space-y-1.5">
				<p class="text-xs text-ink-gray-5" id="first-admin-label">First team admin</p>
				<div v-if="firstAdmin" class="flex items-center gap-2 rounded-4 border border-outline-gray-1 px-2 py-1.5" aria-labelledby="first-admin-label">
					<Avatar :label="displayName(firstAdmin.name, firstAdmin.email)" size="md" />
					<div class="min-w-0 flex-1">
						<p class="truncate text-base text-ink-gray-8">{{ displayName(firstAdmin.name, firstAdmin.email) }}</p>
						<p class="truncate text-sm text-ink-gray-6">{{ firstAdmin.email }}</p>
					</div>
					<Button variant="ghost" label="Change" @click="firstAdmin = null" />
				</div>
				<PersonSearch v-else :exclude="[]" placeholder="Search people by name or email" @pick="(person) => (firstAdmin = person)" />
				<p v-if="adminError" class="text-xs text-ink-red-6">{{ adminError }}</p>
				<p v-else class="text-xs text-ink-gray-5">They add the rest of the team. You can add more team admins later.</p>
			</div>
			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :label="team ? 'Save' : 'Create'" :loading="saving" />
			</div>
		</form>
	</Dialog>
</template>
