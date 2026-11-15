<script setup lang="ts">
import { Button } from "frappe-ui";
import { computed, onBeforeUnmount, ref } from "vue";
import DialogFrame from "./DialogFrame.vue";
import { cancelPendingDialog, type PendingDialog } from "./dialogs";

/**
 * A confirm, danger or prompt dialog (dialogs.ts) while frappe-ui's dialog code arrives: the
 * same box with its title, message and buttons, and each field's label and value, so the
 * dialog takes its place without a move. The buttons that act wait for it; Cancel works.
 * It shows after 100ms, so a dialog whose code is already on the device never flashes it.
 * The markup copies frappe-ui's Dialog and its imperative dialogs (utils/dialog.ts).
 */
const props = defineProps<{ request: PendingDialog }>();
const shown = ref(false);
const timer = setTimeout(() => (shown.value = true), 100);
onBeforeUnmount(() => clearTimeout(timer));

const ICONS = { red: "lucide-alert-triangle", amber: "lucide-alert-triangle", blue: "lucide-info", green: "lucide-check-circle" } as const;
const ICON_LOOK = {
	red: "bg-surface-red-2 text-ink-red-7",
	amber: "bg-surface-amber-2 text-ink-amber-5",
	blue: "bg-surface-blue-2 text-ink-blue-5",
	green: "bg-surface-green-2 text-ink-green-5",
} as const;

const view = computed(() => {
	const { kind, args } = props.request;
	const theme = kind === "danger" ? "red" : "theme" in args ? args.theme : undefined;
	const custom = "icon" in args && typeof args.icon === "string" ? args.icon : undefined;
	const icon = custom ?? (theme ? ICONS[theme] : undefined);
	const actions = kind !== "prompt" && args.actions?.length ? args.actions.map(({ onClick: _, ...button }) => button) : null;
	return {
		title: args.title,
		message: args.message,
		icon,
		iconLook: theme ? ICON_LOOK[theme] : "bg-surface-gray-2 text-ink-gray-5",
		size: { xs: "max-w-xs", sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-xl", "2xl": "max-w-2xl" }[String(args.size ?? "md")] ?? "max-w-md",
		dismissible: args.dismissible !== false,
		fields: kind === "prompt" ? props.request.args.fields : null,
		actions,
		confirm: args.confirmLabel ?? (kind === "danger" ? "Delete" : kind === "prompt" ? "Submit" : "Confirm"),
		confirmTheme: theme === "amber" ? undefined : theme,
		cancel: args.cancelLabel ?? "Cancel",
	};
});

function close() {
	if (view.value.dismissible) cancelPendingDialog();
}
</script>

<template>
	<DialogFrame v-if="shown" :label="view.title ?? 'Dialog'" :size="view.size" @close="close">
		<div class="bg-surface-elevation-1 px-4 pb-6 pt-5 sm:px-6">
			<div class="mb-6 flex items-center justify-between">
				<div class="flex flex-1 items-center space-x-2">
					<div v-if="view.icon" :class="['flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full', view.iconLook]">
						<span :class="[view.icon, 'size-4']" aria-hidden="true" />
					</div>
					<header class="flex-1">
						<h3 v-if="view.title" class="text-2xl-semibold leading-6 text-ink-gray-8">{{ view.title }}</h3>
					</header>
				</div>
				<Button v-if="view.dismissible" variant="ghost" label="Close" @click="close">
					<template #icon><span class="lucide-x size-4 text-ink-gray-9" /></template>
				</Button>
			</div>
			<div v-if="view.fields" class="space-y-3">
				<p v-if="view.message" class="text-p-base text-ink-gray-7">{{ view.message }}</p>
				<div v-for="field in view.fields" :key="field.name" class="space-y-1">
					<div class="space-y-1.5">
						<div v-if="field.label" class="block text-sm leading-tighter text-ink-gray-6">
							{{ field.label }}<span v-if="field.required" class="ml-1 select-none text-ink-red-5" aria-hidden="true">*</span>
						</div>
						<!-- frappe-ui's text field and its three-row text area, with the value they open with. -->
						<div
							v-if="field.type === 'textarea'"
							class="h-[calc(3lh+0.875rem)] overflow-hidden whitespace-pre-wrap break-words rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 py-1.5 text-p-sm text-ink-gray-8"
						>{{ field.defaultValue ?? "" }}</div>
						<div v-else class="flex h-7 items-center truncate rounded-4 border border-[--surface-gray-2] bg-surface-gray-2 px-2 text-base leading-tighter text-ink-gray-8">
							{{ field.type === "checkbox" ? "" : (field.defaultValue ?? "") }}
						</div>
					</div>
				</div>
			</div>
			<div v-else-if="view.message" class="space-y-2">
				<p class="text-p-base text-ink-gray-7">{{ view.message }}</p>
			</div>
		</div>
		<div class="px-4 pb-7 pt-4 sm:px-6">
			<div v-if="view.actions" class="flex justify-end gap-2">
				<Button v-for="action in view.actions" :key="action.label" v-bind="action" disabled />
			</div>
			<div v-else class="flex flex-row-reverse gap-2">
				<Button :label="view.confirm" variant="solid" :theme="view.confirmTheme" disabled />
				<Button :label="view.cancel" variant="outline" @click="cancelPendingDialog" />
			</div>
		</div>
	</DialogFrame>
</template>
