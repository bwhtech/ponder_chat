import { ref } from "vue";

/** Phones get MobileShell and its tab bar. Wider screens get DesktopShell. */
const query = matchMedia("(max-width: 767px)");
export const isMobile = ref(query.matches);
query.addEventListener("change", (event) => (isMobile.value = event.matches));
