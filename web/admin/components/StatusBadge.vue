<script setup lang="ts">
import { Badge } from "frappe-ui";
import type { Status } from "../api";

defineProps<{ status: Status }>();

const label = { active: "Active", invited: "Invited", banned: "Banned" } as const;
const theme = { active: "gray", invited: "blue", banned: "red" } as const;
</script>

<template>
	<Badge :label="label[status]" :theme="theme[status]" variant="subtle" />
</template>
