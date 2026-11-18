import { fileURLToPath } from "node:url";
import preset, { content } from "frappe-ui/tailwind";
import { content as aiElements } from "frappe-ui-ai-elements/tailwind";
import plugin from "tailwindcss/plugin";

const here = new URL(".", import.meta.url).pathname;
const frappeUI = fileURLToPath(new URL("node_modules/frappe-ui/", import.meta.url));

/**
 * The classes Tailwind writes come from the files it reads. /admin, and `npm run dev`, which
 * serves both pages, read everything. The chat's build (vite.config.ts) reads only what the
 * chat can draw: frappe-ui's main entry (its components, composables and utils, not the
 * experimental components or its docs theme, which only /admin uses), its charts and lists
 * (a reply's cards, web/genui/), the AI elements, and web/ without web/admin/. Its
 * stylesheet is render-blocking on every first visit.
 */
const chatOnly = process.env.PONDER_PAGE === "chat";
const chatContent = [
	...["components", "composables", "utils", "data-fetching", "resources", "directives"].map((dir) => `${frappeUI}src/${dir}/**/*.{vue,js,ts}`),
	`${frappeUI}icons/**/*.{vue,js,ts}`,
	// A reply's cards (web/genui/components.ts) draw with frappe-ui's charts and lists.
	`${frappeUI}src/charts/**/*.{vue,ts}`,
	`${frappeUI}src/molecules/list/**/*.{vue,ts}`,
	`!${frappeUI}**/stories/**`,
	`!${frappeUI}**/docs/**`,
	...aiElements,
	`${here}web/**/*.{html,vue,ts}`,
	`!${here}web/admin/**`,
	// admin.html draws /admin's first screen with the admin's classes, which the chat never uses.
	`!${here}web/admin.html`,
];

/**
 * `pose:`, a decorative move while the pointer is on the `group` (the setup cards' scenes). As
 * frappe-ui's `hover:` and `group-hover:`, only where a fine pointer can hover, so a tap does not
 * leave it stuck; and only when motion is allowed, so it does not jump with reduced motion.
 */
const pose = plugin(({ addVariant }) =>
	addVariant("pose", "@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) { .group:hover & }"),
);

/** @type {import('tailwindcss').Config} */
export default {
	presets: [preset],
	content: chatOnly ? chatContent : [...content, ...aiElements, `${here}web/**/*.{html,vue,ts}`],
	plugins: [pose],
};
