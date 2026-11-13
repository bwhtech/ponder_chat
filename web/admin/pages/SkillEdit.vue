<script setup lang="ts">
import { Alert, Breadcrumbs, Button, Dropdown, FormControl, PageHeader, PageHeaderMobile, Skeleton, Switch, TabButtons, dialog, toast } from "frappe-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import { checkSkill, MAX_DESCRIPTION, parseSkillFile, skillTitle, toSkillName, type SkillFields } from "../../../shared/skill-file";
import { Response } from "frappe-ui-ai-elements";
import { admin, ApiError, unwrap, type SkillDetail } from "../api";
import NewSkillDialog from "../components/NewSkillDialog.vue";
import SkillInstructionsEditor from "../components/SkillInstructionsEditor.vue";
import { lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";
import EmptyState from "../../EmptyState.vue";

/**
 * One skill: its instructions in the code editor, and its name, description and switches
 * beside them. The server keeps the skill as one SKILL.md file (server/skills.ts), which
 * "Download SKILL.md" gives. A whole SKILL.md pasted into the instructions fills in the fields.
 */
const props = defineProps<{ id: string }>();
const router = useRouter();

type Form = SkillFields & { enabled: boolean };
const skill = ref<SkillDetail | null>(null);
const form = ref<Form>({ name: "", description: "", automatic: true, body: "", enabled: false });
/** What was last loaded or saved, to tell whether there are changes to save. */
const saved = ref<Form>({ ...form.value });
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string; missing: boolean }>({ kind: "loading" });
const saving = ref(false);
const serverErrors = ref<string[]>([]);
const duplicating = ref(false);

async function load() {
	status.value = { kind: "loading" };
	try {
		show(await unwrap(admin.skills[":id"].$get({ param: { id: props.id } })));
		status.value = { kind: "loaded" };
	} catch (e) {
		status.value = { kind: "error", message: (e as Error).message, missing: e instanceof ApiError && e.status === 404 };
	}
}

function show(loaded: SkillDetail) {
	skill.value = loaded;
	const { name, description, automatic, body, enabled } = loaded;
	form.value = { name, description, automatic, body, enabled };
	saved.value = { ...form.value };
	serverErrors.value = [];
}

watch(() => props.id, load, { immediate: true });

// Typed as words, kept as a name: "Meeting Notes" becomes "meeting-notes".
watch(
	() => form.value.name,
	(typed) => {
		const cleaned = toSkillName(typed);
		if (cleaned !== typed) form.value.name = cleaned;
	},
);

// A whole SKILL.md pasted into the instructions: its frontmatter fills in the fields.
watch(
	() => form.value.body,
	(body) => {
		const pasted = body.trimStart().startsWith("---") ? parseSkillFile(body.trimStart()) : null;
		if (!pasted) return;
		form.value = {
			...form.value,
			...pasted,
			name: pasted.name ? toSkillName(pasted.name) : form.value.name,
			description: pasted.description || form.value.description,
		};
		toast.info("Took the name, description and kind from the pasted file");
	},
);

const errors = computed(() => [...new Set([...checkSkill(form.value, form.value.enabled), ...serverErrors.value])]);
watch(form, () => (serverErrors.value = []), { deep: true });
const dirty = computed(() => (Object.keys(form.value) as (keyof Form)[]).some((key) => form.value[key] !== saved.value[key]));

const tab = ref("edit");
const tabs = [
	{ label: "Edit", value: "edit" },
	{ label: "Preview", value: "preview" },
];
const words = computed(() => form.value.body.split(/\s+/).filter(Boolean).length);
const heading = computed(() => (skill.value ? skillTitle(skill.value.name) : "Skill"));

async function save() {
	if (errors.value.length) return toast.error(errors.value[0]!);
	saving.value = true;
	try {
		const result = await unwrap(
			admin.skills[":id"].$put({ param: { id: props.id }, json: { ...form.value, expectedUpdatedAt: skill.value?.updatedAt } }),
		);
		show(result);
		toast.success(result.enabled ? "Saved. New replies use it now." : "Saved");
	} catch (e) {
		if (e instanceof ApiError && e.errors.length) serverErrors.value = e.errors;
		toast.error((e as Error).message);
	} finally {
		saving.value = false;
	}
}

function remove() {
	const current = skill.value;
	if (!current) return;
	dialog.danger({
		title: `Delete ${skillTitle(current.name)}?`,
		message: "No one can use it after this. Chats that used it keep their replies.",
		confirmLabel: "Delete",
		onConfirm: async () => {
			await unwrap(admin.skills[":id"].$delete({ param: { id: String(current.id) } }));
			saved.value = { ...form.value };
			toast.success(`Deleted ${skillTitle(current.name)}`);
			await router.push("/skills");
		},
	});
}

/** The saved file. Unsaved changes are not in it. */
function download() {
	const current = skill.value;
	if (!current) return;
	const url = URL.createObjectURL(new Blob([current.source], { type: "text/markdown" }));
	const link = Object.assign(document.createElement("a"), { href: url, download: `${current.name}.md` });
	link.click();
	URL.revokeObjectURL(url);
}

const more = computed(() => [
	{ label: "Download SKILL.md", icon: "lucide-download", onClick: download },
	{ label: "Duplicate", icon: "lucide-copy", onClick: () => (duplicating.value = true) },
	{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: remove },
]);

// Unsaved changes: ask before leaving the page, and before closing the tab.
onBeforeRouteLeave(() => !dirty.value || window.confirm("Leave without saving your changes to this skill?"));
const warnOnClose = (event: BeforeUnloadEvent) => {
	if (dirty.value) event.preventDefault();
};
addEventListener("beforeunload", warnOnClose);
onBeforeUnmount(() => removeEventListener("beforeunload", warnOnClose));

// Cmd/Ctrl+S saves.
function onKeydown(event: KeyboardEvent) {
	if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		if (dirty.value && !saving.value) void save();
	}
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col" @keydown="onKeydown">
		<PageHeaderMobile v-if="isMobile" :title="heading">
			<template #prefix><Button variant="ghost" icon="lucide-chevron-left" aria-label="Back to skills" route="/skills" /></template>
			<template #suffix>
				<Button v-if="status.kind !== 'error'" variant="solid" theme="gray" label="Save" :loading="saving" :disabled="status.kind !== 'loaded' || !dirty" @click="save" />
			</template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<Breadcrumbs class="-ml-0.5" :items="[{ label: 'Skills', route: '/skills' }, ...(skill ? [{ label: heading }] : [])]" />
			<div class="ml-auto flex items-center gap-2">
				<span v-if="dirty" class="text-sm text-ink-gray-6">Not saved</span>
				<Dropdown v-if="status.kind === 'loaded'" :options="more">
					<Button variant="ghost" icon="lucide-ellipsis" aria-label="More" />
				</Dropdown>
				<Button v-if="status.kind !== 'error'" variant="solid" theme="gray" label="Save" :loading="saving" :disabled="status.kind !== 'loaded' || !dirty" @click="save" />
			</div>
		</PageHeader>

		<div v-if="status.kind === 'error'" class="flex-1 px-3 pt-4 sm:px-5 md:pt-6">
			<EmptyState
				:icon="status.missing ? 'lucide-file-x' : 'lucide-circle-alert'"
				:title="status.missing ? 'This skill was deleted' : 'The skill could not load'"
				:body="status.missing ? undefined : status.message"
				alert
			>
				<div class="flex gap-2">
					<Button label="Back to skills" route="/skills" />
					<Button v-if="!status.missing" label="Try again" @click="load" />
				</div>
			</EmptyState>
		</div>

		<div v-else-if="status.kind === 'loading'" class="flex min-h-0 flex-1 flex-col md:flex-row" aria-busy="true" aria-label="Loading the skill">
			<div class="flex min-h-[28rem] min-w-0 flex-1 flex-col px-3 pb-5 pt-4 sm:px-5 md:pt-6">
				<Skeleton class="h-7 w-40 rounded-4" />
				<Skeleton class="mt-3 min-h-0 flex-1 rounded-4" />
			</div>
			<aside class="w-full shrink-0 space-y-6 border-t border-outline-gray-1 px-3 pb-10 pt-5 sm:px-5 md:w-[22rem] md:border-l md:border-t-0 md:pt-6">
				<div v-for="width in ['w-24', 'w-32', 'w-20']" :key="width" class="space-y-2">
					<Skeleton :class="['h-3.5 rounded-4', width]" />
					<Skeleton class="h-7 w-full rounded-4" />
				</div>
			</aside>
		</div>

		<div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
			<div class="flex min-h-[28rem] min-w-0 flex-1 flex-col px-3 pb-5 pt-4 sm:px-5 md:pt-6">
				<div class="flex items-center gap-3">
					<TabButtons v-model="tab" :options="tabs" class="w-max" />
					<span class="ml-auto truncate text-sm text-ink-gray-6">Instructions · {{ words }} words</span>
				</div>
				<SkillInstructionsEditor v-if="tab === 'edit'" v-model="form.body" class="mt-3 min-h-0 flex-1" />
				<div v-else class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-4 border border-outline-gray-2 p-5">
					<Response v-if="form.body.trim()" :content="form.body" class="max-w-[770px]" />
					<p v-else class="text-p-sm text-ink-gray-6">No instructions yet.</p>
				</div>
			</div>

			<aside class="w-full shrink-0 space-y-6 overflow-y-auto border-t border-outline-gray-1 px-3 pb-10 pt-5 sm:px-5 md:w-[22rem] md:border-l md:border-t-0 md:pt-6">
				<Alert v-if="errors.length" theme="red" title="Fix before you save">
					<template #description>
						<ul class="list-disc space-y-1 pl-4 text-p-sm">
							<li v-for="error in errors" :key="error">{{ error }}</li>
						</ul>
					</template>
				</Alert>

				<div class="space-y-4">
					<FormControl
						v-model="form.name"
						label="Name"
						required
						autocomplete="off"
						:description="`People type $${form.name || 'name'} anywhere in a message to use it.`"
					/>
					<FormControl
						v-model="form.description"
						type="textarea"
						label="Description"
						required
						:rows="4"
						:description="`Ponder reads it to decide when to use the skill. ${form.description.length} of ${MAX_DESCRIPTION} characters.`"
					/>
				</div>

				<div class="space-y-4 border-t border-outline-gray-1 pt-5">
					<Switch v-model="form.enabled" label="On for everyone" description="Off: no one can use it, and Ponder does not see it." />
					<Switch v-model="form.automatic" label="Ponder can use it on its own" description="Off: it runs only when someone types its name." />
				</div>

				<div class="space-y-3 border-t border-outline-gray-1 pt-5">
					<p class="text-sm text-ink-gray-6">What Ponder sees first</p>
					<p v-if="form.automatic" class="break-words rounded-4 bg-surface-gray-1 p-3 font-mono text-xs leading-5 text-ink-gray-7">
						- {{ form.name || "name" }}: {{ form.description || "…" }}
					</p>
					<p v-else class="text-p-sm text-ink-gray-6">Nothing. The skill is not in the instructions until someone asks for it.</p>
				</div>

				<div v-if="skill" class="space-y-1 border-t border-outline-gray-1 pt-5 text-sm">
					<p class="text-ink-gray-6">Last edit</p>
					<p class="text-ink-gray-7">{{ skill.updatedBy ? `${skill.updatedBy}, ` : "" }}{{ lastActive(skill.updatedAt) }}</p>
				</div>
			</aside>
		</div>

		<NewSkillDialog v-model:open="duplicating" :from="skill" />
	</div>
</template>
