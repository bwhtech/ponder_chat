<script setup lang="ts">
import { Alert, Breadcrumbs, Button, Dropdown, PageHeader, PageHeaderMobile, Switch, TabButtons, dialog, toast } from "frappe-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { onBeforeRouteLeave, useRoute, useRouter } from "vue-router";
import { MAX_DESCRIPTION, NEW_SKILL_FILE, parseSkillFile, setAutomatic, skillTitle } from "../../../shared/skill-file";
import Response from "../../ai-elements/response/Response.vue";
import { api, ApiError, type SkillDetail } from "../api";
import SkillFileEditor from "../components/SkillFileEditor.vue";
import { lastActive } from "../lib/format";
import { isMobile } from "../lib/viewport";

/**
 * One skill's file, in the code editor. The side panel reads the file as it is typed: what
 * stops a save, the two switches, and the line Ponder sees. The "automatic" switch writes
 * `disable-model-invocation` into the frontmatter, so the file stays the one source of truth.
 *
 * /skills/new makes a skill; /skills/new?from=<id> starts from a copy of another.
 */
const props = defineProps<{ id?: string }>();
const route = useRoute();
const router = useRouter();

const skill = ref<SkillDetail | null>(null);
const source = ref("");
const enabled = ref(true);
/** What was last loaded or saved, to tell whether there are changes to save. */
const saved = ref({ source: "", enabled: true });
const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string; missing: boolean }>({ kind: "loading" });
const saving = ref(false);
const serverErrors = ref<string[]>([]);

const isNew = computed(() => !props.id);

async function load() {
	status.value = { kind: "loading" };
	try {
		if (props.id) {
			show(await api<SkillDetail>(`/skills/${props.id}`));
		} else {
			const from = typeof route.query.from === "string" ? await api<SkillDetail>(`/skills/${route.query.from}`) : null;
			skill.value = null;
			source.value = from ? copyOf(from.source, from.name) : NEW_SKILL_FILE;
			// A copy starts off, so it never runs twice before it is edited.
			enabled.value = !from;
			saved.value = { source: source.value, enabled: enabled.value };
		}
		status.value = { kind: "loaded" };
	} catch (e) {
		status.value = { kind: "error", message: (e as Error).message, missing: e instanceof ApiError && e.status === 404 };
	}
}

function show(loaded: SkillDetail) {
	skill.value = loaded;
	source.value = loaded.source;
	enabled.value = loaded.enabled;
	saved.value = { source: loaded.source, enabled: loaded.enabled };
	serverErrors.value = [];
}

/** A copy gets "-copy" on its name, so it does not clash with the skill it came from. */
function copyOf(text: string, name: string) {
	return text.replace(/^name:.*$/m, `name: ${name}-copy`);
}

watch(() => [props.id, route.query.from], load, { immediate: true });

const file = computed(() => parseSkillFile(source.value));
const errors = computed(() => [...new Set([...file.value.errors, ...serverErrors.value])]);
watch(source, () => (serverErrors.value = []));
const dirty = computed(() => source.value !== saved.value.source || enabled.value !== saved.value.enabled);

const automatic = computed({
	get: () => file.value.automatic,
	set: (on: boolean) => (source.value = setAutomatic(source.value, on)),
});

const tab = ref("edit");
const tabs = [
	{ label: "Edit", value: "edit" },
	{ label: "Preview", value: "preview" },
];
const words = computed(() => file.value.body.split(/\s+/).filter(Boolean).length);
const heading = computed(() => (skill.value ? skillTitle(skill.value.name) : "New skill"));

async function save() {
	if (errors.value.length) return toast.error("Fix the problems in the file first");
	saving.value = true;
	try {
		const body = { source: source.value, enabled: enabled.value, expectedUpdatedAt: skill.value?.updatedAt };
		const result = skill.value
			? await api<SkillDetail>(`/skills/${skill.value.id}`, { method: "PUT", body })
			: await api<SkillDetail>("/skills", { body });
		show(result);
		toast.success(isNew.value ? `Created ${skillTitle(result.name)}` : "Saved. New replies use it now.");
		if (isNew.value) await router.replace(`/skills/${result.id}`);
	} catch (e) {
		const message = (e as Error).message;
		if (e instanceof ApiError && e.errors.length) serverErrors.value = e.errors;
		toast.error(message);
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
			await api(`/skills/${current.id}`, { method: "DELETE" });
			saved.value = { source: source.value, enabled: enabled.value };
			toast.success(`Deleted ${skillTitle(current.name)}`);
			await router.push("/skills");
		},
	});
}

function download() {
	const url = URL.createObjectURL(new Blob([source.value], { type: "text/markdown" }));
	const link = Object.assign(document.createElement("a"), { href: url, download: `${file.value.name || "skill"}.md` });
	link.click();
	URL.revokeObjectURL(url);
}

const more = computed(() => [
	{ label: "Download .md", icon: "lucide-download", onClick: download },
	...(skill.value ? [{ label: "Delete", icon: "lucide-trash-2", theme: "red" as const, onClick: remove }] : []),
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
				<Button variant="solid" theme="gray" :label="isNew ? 'Create' : 'Save'" :loading="saving" :disabled="!dirty && !isNew" @click="save" />
			</template>
		</PageHeaderMobile>
		<PageHeader v-else>
			<Breadcrumbs :items="[{ label: 'Skills', route: '/skills' }, { label: heading }]" />
			<div class="ml-auto flex items-center gap-2">
				<span v-if="dirty && status.kind === 'loaded'" class="text-sm text-ink-gray-5">Not saved</span>
				<Dropdown v-if="status.kind === 'loaded'" :options="more">
					<Button variant="ghost" icon="lucide-ellipsis" aria-label="More" />
				</Dropdown>
				<Button
					variant="solid"
					theme="gray"
					:label="isNew ? 'Create' : 'Save'"
					:loading="saving"
					:disabled="status.kind !== 'loaded' || (!dirty && !isNew)"
					@click="save"
				/>
			</div>
		</PageHeader>

		<div v-if="status.kind === 'error'" class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center" role="alert">
			<p class="text-base text-ink-gray-7">{{ status.missing ? "This skill was deleted" : "The skill could not load" }}</p>
			<p v-if="!status.missing" class="text-sm text-ink-gray-5">{{ status.message }}</p>
			<div class="flex gap-2">
				<Button label="Back to skills" route="/skills" />
				<Button v-if="!status.missing" label="Try again" @click="load" />
			</div>
		</div>

		<div v-else-if="status.kind === 'loading'" class="flex-1" aria-busy="true" aria-label="Loading the skill" />

		<div v-else class="flex min-h-0 flex-1 flex-col md:flex-row">
			<div class="flex min-h-[28rem] min-w-0 flex-1 flex-col px-3 pb-5 pt-4 sm:px-5">
				<div class="flex items-center gap-3">
					<TabButtons v-model="tab" :options="tabs" class="w-max" />
					<span class="ml-auto truncate font-mono text-xs text-ink-gray-5">{{ file.name || "skill" }}.md · {{ words }} words</span>
				</div>
				<SkillFileEditor v-if="tab === 'edit'" v-model="source" class="mt-3 min-h-0 flex-1" />
				<div v-else class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-4 border border-outline-gray-2 p-5">
					<div class="mb-4 flex items-baseline gap-2 border-b border-outline-gray-1 pb-3">
						<span class="lucide-sparkles size-4 shrink-0 self-center text-ink-violet-6" aria-hidden="true" />
						<span class="shrink-0 font-mono text-sm text-ink-gray-9">${{ file.name || "name" }}</span>
						<span class="min-w-0 text-sm text-ink-gray-5">{{ file.description }}</span>
					</div>
					<Response :content="file.body" class="max-w-[770px]" />
				</div>
			</div>

			<aside class="w-full shrink-0 space-y-6 overflow-y-auto border-t border-outline-gray-1 px-5 pb-10 pt-5 md:w-[20rem] md:border-l md:border-t-0">
				<Alert v-if="errors.length" theme="red" title="Fix before you save">
					<template #description>
						<ul class="list-disc space-y-1 pl-4 text-p-sm">
							<li v-for="error in errors" :key="error">{{ error }}</li>
						</ul>
					</template>
				</Alert>

				<div class="space-y-4">
					<Switch v-model="enabled" label="On for everyone" description="Off: no one can use it, and Ponder does not see it." />
					<Switch
						v-model="automatic"
						label="Ponder can use it on its own"
						description="Off: it runs only when someone types its name. Sets disable-model-invocation."
					/>
				</div>

				<div class="space-y-3 border-t border-outline-gray-1 pt-5">
					<p class="text-sm text-ink-gray-5">How people start it</p>
					<p class="text-p-sm text-ink-gray-7">
						Type <span class="rounded-1 bg-surface-gray-2 px-1 font-mono text-ink-gray-9">${{ file.name || "name" }}</span> anywhere in a message.
					</p>
				</div>

				<div class="space-y-3 border-t border-outline-gray-1 pt-5">
					<p class="text-sm text-ink-gray-5">What Ponder sees first</p>
					<p v-if="automatic" class="break-words rounded-4 bg-surface-gray-1 p-3 font-mono text-xs leading-5 text-ink-gray-7">
						- {{ file.name || "name" }}: {{ file.description || "…" }}
					</p>
					<p v-else class="text-p-sm text-ink-gray-6">Nothing. The skill is not in the instructions until someone asks for it.</p>
					<p class="text-xs tabular-nums" :class="file.description.length > MAX_DESCRIPTION ? 'text-ink-red-5' : 'text-ink-gray-5'">
						Description: {{ file.description.length }} of {{ MAX_DESCRIPTION }} characters
					</p>
				</div>

				<div v-if="skill" class="space-y-1 border-t border-outline-gray-1 pt-5 text-sm">
					<p class="text-ink-gray-5">Last edit</p>
					<p class="text-ink-gray-7">{{ skill.updatedBy ? `${skill.updatedBy}, ` : "" }}{{ lastActive(skill.updatedAt) }}</p>
				</div>
			</aside>
		</div>
	</div>
</template>
