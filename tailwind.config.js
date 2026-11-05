import preset, { content } from "frappe-ui/tailwind";

const here = new URL(".", import.meta.url).pathname;

/** @type {import('tailwindcss').Config} */
export default {
	presets: [preset],
	content: [...content, `${here}web/**/*.{html,vue,ts}`],
	theme: {
		extend: {
			// `ease-out-strong`: the curve for things that enter, leave or open. Defined in style.css.
			transitionTimingFunction: { "out-strong": "var(--ease-out-strong)" },
		},
	},
};
