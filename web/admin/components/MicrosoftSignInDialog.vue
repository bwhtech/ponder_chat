<script setup lang="ts">
import { BottomSheet, Dialog } from "frappe-ui";
import type { MicrosoftSignIn } from "../api";
import { isMobile } from "../lib/viewport";
import MicrosoftSignInForm from "./MicrosoftSignInForm.vue";

/**
 * Configure sign-in with Microsoft: a wide dialog, with Entra's steps beside the fields, or a
 * bottom sheet on a phone. `turningOn` when it opened from the switch: saving turns Microsoft on.
 */
defineProps<{ microsoft: MicrosoftSignIn; redirectUris: string[]; turningOn: boolean }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [microsoft: MicrosoftSignIn] }>();

function saved(microsoft: MicrosoftSignIn) {
	emit("saved", microsoft);
	open.value = false;
}
</script>

<template>
	<BottomSheet v-if="isMobile" v-model:open="open" title="Sign in with Microsoft">
		<div class="px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
			<MicrosoftSignInForm :microsoft="microsoft" :redirect-uris="redirectUris" :turning-on="turningOn" @saved="saved" @cancel="open = false" />
		</div>
	</BottomSheet>
	<Dialog v-else v-model:open="open" title="Sign in with Microsoft" size="3xl">
		<MicrosoftSignInForm :microsoft="microsoft" :redirect-uris="redirectUris" :turning-on="turningOn" @saved="saved" @cancel="open = false" />
	</Dialog>
</template>
