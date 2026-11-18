<script setup lang="ts">
/**
 * frappe-ui's Breadcrumbs while its code arrives (breadcrumbs.ts): the same markup and classes
 * for a parent link and the current page, so nothing moves when it takes this place. The
 * parent link works already. Like Breadcrumbs, `class` goes on the root.
 */
defineProps<{ parent: { label: string; href: string; onClick: () => void }; current: string }>();

function follow(event: MouseEvent, onClick: () => void) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	onClick();
}
</script>

<template>
	<div class="flex min-w-0 items-center">
		<div class="flex min-w-0 items-center text-ellipsis whitespace-nowrap leading-tighter">
			<a :href="parent.href" class="flex items-center rounded-4 px-0.5 py-1 text-lg-medium leading-tighter text-ink-gray-5 hover:text-ink-gray-7" @click="follow($event, parent.onClick)">
				<span>{{ parent.label }}</span>
			</a>
			<span class="mx-0.5 text-base text-ink-gray-4" aria-hidden="true">/</span>
			<span class="flex min-w-0 items-center rounded-4 px-0.5 py-1 text-lg-medium leading-tighter text-ink-gray-9">
				<span class="min-w-0 truncate" :title="current">{{ current }}</span>
			</span>
		</div>
	</div>
</template>
