import type { toast as frappeToast } from "frappe-ui";
import { ref } from "vue";
import { once } from "./once";

type Kind = "success" | "error" | "warning" | "info";
/** A toast's message and options: the same for the four kinds. */
type Args = Parameters<(typeof frappeToast)["success"]>;

/**
 * frappe-ui's toasts, loaded with the first one: vue-sonner, and DOMPurify, which cleans a
 * toast's text, are 50 KB that the first page never shows. Use this `toast`, not
 * frappe-ui's. App.vue mounts the host (ToastsHost.vue) once `toastsWanted` is true.
 * vue-sonner drops a toast sent before its host listens, so each toast waits for the host.
 */
export const toastsWanted = ref(false);
let hostMounted!: () => void;
const hostReady = new Promise<void>((resolve) => (hostMounted = resolve));
/** ToastsHost.vue calls this once vue-sonner listens. */
export const toastsListen = () => hostMounted();
export const loadToasts = once(() => import("./toasts-host"));

export const toast = {
	success: (...args: Args) => show("success", args),
	error: (...args: Args) => show("error", args),
	warning: (...args: Args) => show("warning", args),
	info: (...args: Args) => show("info", args),
};

function show(kind: Kind, args: Args) {
	toastsWanted.value = true;
	void Promise.all([loadToasts(), hostReady]).then(([module]) => module.toast[kind](...args));
}
