import preset, { content } from "frappe-ui/tailwind";

const here = new URL(".", import.meta.url).pathname;

/** @type {import('tailwindcss').Config} */
export default {
	presets: [preset],
	content: [...content, `${here}web/**/*.{html,vue,ts}`],
};
