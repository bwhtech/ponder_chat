import preset, { content } from "frappe-ui/tailwind";
import { content as aiElements } from "frappe-ui-ai-elements/tailwind";

const here = new URL(".", import.meta.url).pathname;

/** @type {import('tailwindcss').Config} */
export default {
	presets: [preset],
	content: [...content, ...aiElements, `${here}web/**/*.{html,vue,ts}`],
};
