<script setup lang="ts">
import { workspaceDialog } from "./dialogs";
import ShareDialog from "./ShareDialog.vue";
import WorkspaceFormDialog from "./WorkspaceFormDialog.vue";

/** The workspace dialogs (dialogs.ts), as one chunk that loads the first time one opens. */
</script>

<template>
	<template v-if="workspaceDialog.request">
		<ShareDialog v-if="workspaceDialog.request.kind === 'share'" :key="workspaceDialog.serial" :request="workspaceDialog.request" />
		<WorkspaceFormDialog v-else :key="workspaceDialog.serial" :request="workspaceDialog.request" />
	</template>
</template>
