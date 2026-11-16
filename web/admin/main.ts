import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { loadLogos } from "../brand";
import { pages, routes } from "./router";
import { askViewer, viewer, viewerError } from "./store";
import "./style.css";

// The admin pages: their own app, with routes under /admin/ (server/app.ts serves admin.html for all of them).
const router = createRouter({ history: createWebHistory("/admin/"), routes });
const app = createApp(App).use(router);

// admin.html draws the frame with skeletons before any code runs. Mounting replaces it, so
// mount only once there is something to draw in its place: who is signed in, the logo and the
// first page's code. They load at the same time. Signed out leaves for the sign-in page instead.
// The logo waits 1.5 seconds at most: a request that hangs must not keep the page from drawing.
// A later answer still shows the logo (brand.ts is reactive).
const logoOrTimeout = Promise.race([loadLogos(), new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
void Promise.all([askViewer(), logoOrTimeout, router.isReady().then(() => true, () => false)]).then(([, , ready]) => {
	if (viewer.value === undefined && !viewerError.value) return;
	// Without its code the page would mount empty inside the frame. The frame stays, and says so.
	if (!ready) return showLoadError();
	app.mount("#app");
	alignPulses();
	warmPages();
});

/** In place of the frame's skeleton body: the page could not load, and Try again loads it afresh. */
function showLoadError() {
	const frame = document.querySelector<HTMLElement>("#app [inert]");
	frame?.removeAttribute("inert");
	frame?.removeAttribute("aria-hidden");
	document.querySelector("#app [aria-busy]")?.removeAttribute("aria-busy");
	document.querySelector("#app > * > .sr-only")?.remove();
	for (const host of Array.from(document.querySelectorAll<HTMLElement>("[data-boot-body-host]"))) {
		const box = document.createElement("div");
		box.setAttribute("role", "alert");
		box.className = "mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-16 text-center";
		const title = document.createElement("p");
		title.className = "text-base-semibold text-ink-gray-9";
		title.textContent = "This page could not load";
		const body = document.createElement("p");
		body.className = "text-p-sm text-ink-gray-6";
		body.textContent = "Check your connection, then try again.";
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "h-8 rounded-4 bg-surface-gray-2 px-3 text-base-medium text-ink-gray-8 hover:bg-surface-gray-3";
		retry.textContent = "Try again";
		retry.addEventListener("click", () => location.reload());
		box.append(title, body, retry);
		host.replaceChildren(box);
	}
}

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
	if (from.matched.length && /dynamically imported module|Importing a module script failed|error loading dynamically|Unable to preload CSS/i.test(String(error))) location.assign(router.resolve(to).href);
});
