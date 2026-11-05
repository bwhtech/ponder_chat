<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { computed } from "vue";
import { viewOnClick } from "../file-viewer/viewer";

/** A file chip: an icon or image preview, the name and size, and an optional remove button. */
const props = withDefaults(
	defineProps<{
		name: string;
		size?: number;
		mediaType?: string;
		url?: string;
		state?: "idle" | "uploading" | "done" | "error";
		removable?: boolean;
	}>(),
	{ state: "idle" },
);
defineEmits<{ remove: [] }>();

const isImage = computed(() => props.mediaType?.startsWith("image/") && props.url);
const look = computed(() => fileLook(props.mediaType ?? "", props.name));
const isLink = computed(() => Boolean(props.url) && !props.removable);
const description = computed(() =>
	props.state === "error" ? "Upload failed" : [fileKind(props.mediaType ?? "", props.name), formatSize(props.size)].filter(Boolean).join(" · "),
);

/** The icon and tile colour for a file type. Unknown types stay gray. */
function fileLook(mediaType: string, name: string) {
	if (mediaType.startsWith("image/")) return { icon: "lucide-image", tone: "bg-surface-violet-2 text-ink-violet-6" };
	if (mediaType.includes("pdf") || /\.pdf$/i.test(name)) return { icon: "lucide-file-text", tone: "bg-surface-red-2 text-ink-red-6" };
	if (/\.(csv|tsv|xlsx?|ods)$/i.test(name) || mediaType.includes("sheet") || mediaType.includes("csv"))
		return { icon: "lucide-file-spreadsheet", tone: "bg-surface-green-2 text-ink-green-6" };
	if (/\.(docx?|odt|rtf)$/i.test(name) || mediaType.includes("word")) return { icon: "lucide-file-text", tone: "bg-surface-blue-2 text-ink-blue-6" };
	if (/\.(json|ya?ml|xml|html?|[jt]sx?|py|sql|sh)$/i.test(name)) return { icon: "lucide-file-code", tone: "bg-surface-amber-2 text-ink-amber-6" };
	if (/\.(zip|tar|gz|7z|rar)$/i.test(name)) return { icon: "lucide-file-archive", tone: "bg-surface-orange-2 text-ink-orange-6" };
	return { icon: "lucide-file", tone: "bg-surface-gray-2 text-ink-gray-6" };
}

/** A short type label, such as "PDF" or "CSV", from the extension or the media type. */
function fileKind(mediaType: string, name: string) {
	const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
	if (extension) return extension.toUpperCase();
	if (mediaType.startsWith("image/")) return "Image";
	return mediaType.split("/")[1]?.toUpperCase() ?? "";
}

function formatSize(bytes?: number) {
	if (bytes === undefined) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
	<component
		:is="isLink ? 'a' : 'div'"
		data-slot="attachment"
		:data-state="state"
		:href="isLink ? url : undefined"
		:target="isLink ? '_blank' : undefined"
		:rel="isLink ? 'noreferrer noopener' : undefined"
		:title="name"
		@click="isLink && url && viewOnClick($event, { name, url, mediaType: mediaType ?? '' })"
		:aria-busy="state === 'uploading' || undefined"
		class="group/attachment relative flex w-fit min-w-44 max-w-64 items-center gap-2.5 rounded-6 border border-outline-gray-2 bg-surface-base p-1.5 pr-3 data-[state=error]:border-outline-red-3 [&:is(a)]:transition-[background-color,transform] [&:is(a)]:duration-150 [&:is(a)]:ease-out [&:is(a):hover]:bg-surface-gray-1 [&:is(a):active]:scale-[0.98]"
	>
		<div :class="['flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-4', state === 'uploading' ? '' : look.tone]">
			<Skeleton v-if="state === 'uploading'" class="size-full" />
			<img v-else-if="isImage" :src="url" :alt="name" class="size-full object-cover" />
			<span v-else :class="[look.icon, 'size-4']" aria-hidden="true" />
		</div>
		<div class="min-w-0 flex-1 leading-tight">
			<p class="truncate text-sm-medium text-ink-gray-8">{{ name }}</p>
			<p v-if="description" class="mt-1 truncate text-xs text-ink-gray-5 group-data-[state=error]/attachment:text-ink-red-6">
				{{ description }}
			</p>
		</div>
		<Button v-if="removable" variant="ghost" size="xs" icon="lucide-x" :aria-label="`Remove ${name}`" @click="$emit('remove')" />
	</component>
</template>
