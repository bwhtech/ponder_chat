<script setup lang="ts">
import { Skeleton } from "frappe-ui";

/**
 * Rows shaped like a list of people while it loads: an avatar, a name (and an email with
 * `twoLines`), and a value on the right. Names get different widths so the rows read as text.
 */
withDefaults(defineProps<{ rows?: number; avatar?: "sm" | "md" | "lg" | false; twoLines?: boolean; label: string }>(), {
	rows: 5,
	avatar: "md",
});

const AVATAR = { sm: "size-5", md: "size-6", lg: "size-7" };
const NAMES = ["w-32", "w-40", "w-28", "w-36", "w-44", "w-24"];
const EMAILS = ["w-44", "w-52", "w-40", "w-48", "w-56", "w-36"];
</script>

<template>
	<div class="divide-y divide-outline-gray-1" aria-busy="true" :aria-label="label">
		<div v-for="n in rows" :key="n" class="flex items-center gap-3" :class="twoLines ? 'py-3' : 'py-2.5'">
			<Skeleton v-if="avatar" :class="['shrink-0 rounded-full', AVATAR[avatar]]" />
			<div class="min-w-0 flex-1 space-y-1.5">
				<Skeleton :class="['h-3.5 max-w-full rounded-4', NAMES[(n - 1) % NAMES.length]]" />
				<Skeleton v-if="twoLines" :class="['h-3 max-w-full rounded-4', EMAILS[(n - 1) % EMAILS.length]]" />
			</div>
			<Skeleton class="h-3.5 w-12 shrink-0 rounded-4 md:w-24" />
		</div>
	</div>
</template>
