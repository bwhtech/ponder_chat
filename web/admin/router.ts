import type { RouteRecordRaw } from "vue-router";
import Overview from "./pages/Overview.vue";
import People from "./pages/People.vue";
import Person from "./pages/Person.vue";
import Requests from "./pages/Requests.vue";
import Settings from "./pages/Settings.vue";

export const routes: RouteRecordRaw[] = [
	{ path: "/", component: Overview },
	{ path: "/requests", component: Requests },
	{ path: "/people", component: People },
	{ path: "/people/:id", component: Person, props: true },
	{ path: "/settings", component: Settings },
	{ path: "/:path(.*)*", redirect: "/" },
];
