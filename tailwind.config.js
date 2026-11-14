import { fileURLToPath } from "node:url";
import preset, { content } from "frappe-ui/tailwind";
import { content as aiElements } from "frappe-ui-ai-elements/tailwind";

const here = new URL(".", import.meta.url).pathname;
const frappeUI = fileURLToPath(new URL("node_modules/frappe-ui/", import.meta.url));

/**
 * The classes Tailwind writes come from the files it reads. /admin, and `npm run dev`, which
 * serves both pages, read everything. The chat's build (vite.config.ts) reads only what the
 * chat can draw: frappe-ui's main entry (its components, composables and utils, not the
 * experimental components, charts, lists or its docs theme, which only /admin uses), the
 * AI elements, and web/ without web/admin/. Its stylesheet is render-blocking on every
 * first visit.
 */
const chatOnly = process.env.PONDER_PAGE === "chat";
const chatContent = [
	...["components", "composables", "utils", "data-fetching", "resources", "directives"].map((dir) => `${frappeUI}src/${dir}/**/*.{vue,js,ts}`),
	`${frappeUI}icons/**/*.{vue,js,ts}`,
	`!${frappeUI}**/stories/**`,
	...aiElements,
	`${here}web/**/*.{html,vue,ts}`,
	`!${here}web/admin/**`,
];

/** @type {import('tailwindcss').Config} */
export default {
	presets: [preset],
	content: chatOnly ? chatContent : [...content, ...aiElements, `${here}web/**/*.{html,vue,ts}`],
};
