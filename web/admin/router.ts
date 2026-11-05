import type { RouteRecordRaw } from "vue-router";
import Overview from "./pages/Overview.vue";
import People from "./pages/People.vue";
import Person from "./pages/Person.vue";
import Requests from "./pages/Requests.vue";
import Settings from "./pages/Settings.vue";
import { isMobile } from "./lib/viewport";
import { settingsOpen } from "./store";

export const routes: RouteRecordRaw[] = [
	{ path: "/", component: Overview },
	{ path: "/requests", component: Requests },
	{ path: "/people", component: People },
	{ path: "/people/:id", component: Person, props: true },
	// A page on phones. Wider screens open the settings dialog instead: over the page they
	// are on, or over the overview when /admin/settings is the first page opened.
	{
		path: "/settings",
		component: Settings,
		beforeEnter: (_to, from) => {
			if (isMobile.value) return true;
			settingsOpen.value = true;
			return from.matched.length ? false : "/";
		},
	},
	{ path: "/:path(.*)*", redirect: "/" },
];
