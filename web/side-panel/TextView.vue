<script setup lang="ts">
import { Skeleton } from "frappe-ui";
import { Response } from "frappe-ui-ai-elements";
import { computed, onMounted, ref } from "vue";

/**
 * A text file in a column that reads like a page: Markdown drawn as replies are (as a document
 * artifact, DocumentView.vue), JSON indented, other text as it is.
 */
const props = defineProps<{ url: string; name: string; mediaType: string }>();

const text = ref<string | null>(null);
const failed = ref(false);
const markdown = computed(() => props.mediaType === "text/markdown" || /\.md$/i.test(props.name));

onMounted(async () => {
	try {
		const response = await fetch(props.url);
		if (!response.ok) throw new Error(String(response.status));
		text.value = readable(await response.text());
	} catch {
		failed.value = true;
	}
});

/** JSON with two spaces of indent; JSON that does not parse, as it is. */
function readable(raw: string) {
	if (props.mediaType !== "application/json" && !/\.json$/i.test(props.name)) return raw;
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}
</script>

<template>
	<div v-if="failed" class="flex flex-col items-center gap-2 px-6 pt-[20vh] text-center">
		<p class="text-base text-ink-gray-7">This file could not be shown.</p>
		<a :href="url" :download="name" class="text-sm-medium text-ink-gray-8 underline underline-offset-2">Download it</a>
	</div>
	<p v-else-if="text !== null && !text.trim()" class="px-6 pt-[20vh] text-center text-base text-ink-gray-6">This file is empty.</p>
	<article v-else data-slot="text-file" class="mx-auto w-full max-w-[680px] px-5 pb-16 pt-8 sm:px-10 sm:pt-10" :aria-busy="text === null || undefined">
		<div v-if="text === null" class="flex flex-col gap-2.5">
			<Skeleton v-for="width in ['w-2/5', 'w-full', 'w-11/12', 'w-full', 'w-3/5']" :key="width" :class="['h-3.5 rounded-4', width]" />
		</div>
		<Response v-else-if="markdown" :content="text" />
		<pre v-else class="whitespace-pre-wrap break-words font-mono text-sm text-ink-gray-8">{{ text }}</pre>
	</article>
</template>
