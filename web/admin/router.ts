import type { RouteRecordRaw } from "vue-router";
import { isMobile } from "./lib/viewport";
import { settingsOpen } from "./store";

// Each page is its own chunk, so the first page opened loads only its own code: the charts
// come with Overview and a person, CodeMirror, KaTeX and highlight.js with a skill.
const Overview = () => import("./pages/Overview.vue");
const Requests = () => import("./pages/Requests.vue");
const People = () => import("./pages/People.vue");
const Person = () => import("./pages/Person.vue");
const Skills = () => import("./pages/Skills.vue");
const SkillEdit = () => import("./pages/SkillEdit.vue");
const Workspaces = () => import("./pages/Workspaces.vue");
const Activity = () => import("./pages/Activity.vue");
const Settings = () => import("./pages/Settings.vue");

/** Every page's code. Once the first page is drawn, main.ts loads the rest while the browser is idle, so a tap later opens its page at once. */
export const pages = [Overview, Requests, People, Person, Skills, SkillEdit, Workspaces, Activity, Settings];

export const routes: RouteRecordRaw[] = [
	{ path: "/", component: Overview },
	{ path: "/requests", component: Requests },
	{ path: "/people", component: People },
	{ path: "/people/:id", component: Person, props: true },
	{ path: "/skills", component: Skills },
	{ path: "/skills/:id(\\d+)", component: SkillEdit, props: true },
	{ path: "/workspaces", component: Workspaces },
	{ path: "/activity", component: Activity },
	// A page on phones. Wider screens open the settings dialog instead: over the page they
	// are on, or over the overview when /admin/settings is the first page opened. The guard
	// runs before the page's code loads, so wider screens never load it.
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
