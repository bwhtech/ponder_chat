import { defineAsyncComponent } from "vue";

/**
 * frappe-ui's Alert, with its icons, loaded the first time one shows. The chat shows one only
 * for an error or when the day's credits are used up, never on its first screen (ChatView.vue).
 */
export const Alert = defineAsyncComponent(() => import("./alert").then((module) => module.Alert));
