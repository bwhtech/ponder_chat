import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { pages, routes } from "./router";
import { askViewer, viewer, viewerError } from "./store";
import "./style.css";

// The admin pages: their own app, with routes under /admin/ (server/app.ts serves admin.html for all of them).
const router = createRouter({ history: createWebHistory("/admin/"), routes });
const app = createApp(App).use(router);

// admin.html draws the frame with skeletons before any code runs. Mounting replaces it, so
// mount only once there is something to draw in its place: who is signed in, and the first
// page's code. Both load at the same time. Signed out leaves for the sign-in page instead.
void Promise.all([askViewer(), router.isReady().catch(() => {})]).then(() => {
	if (viewer.value === undefined && !viewerError.value) return;
	app.mount("#app");
	alignPulses();
	warmPages();
});

/** The page's skeletons pulse in step with the frame's that they replace (admin.html), so the swap does not blink. */
function alignPulses() {
	for (const animation of document.getAnimations()) if (animation instanceof CSSAnimation && animation.animationName === "pulse") animation.startTime = 0;
}

/** The other pages' code, while the browser is idle. Safari has no requestIdleCallback. */
function warmPages() {
	const later = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1000));
	later(() => pages.forEach((page) => void page().catch(() => {})));
}

// A page's code that fails to load on a tap, such as after a deploy replaced it, loads with a
// fresh page. Not for the first page: the fresh page would fail the same way, again and again.
router.onError((error, to, from) => {
	if (from.matched.length && /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String(error))) location.assign(router.resolve(to).href);
});
