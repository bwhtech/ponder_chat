import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

const here = new URL(".", import.meta.url).pathname;

export default {
	plugins: [tailwindcss({ config: `${here}tailwind.config.js` }), leanIcons(), autoprefixer()],
};

/**
 * frappe-ui's icon classes (lucide-*, from its Tailwind preset) put each icon's SVG in the
 * CSS twice, for mask-image and -webkit-mask-image, each with Lucide's license comment, its
 * class names and its size, which a mask does not use. The stylesheet carried 200 icons this
 * way, half its size. Here each icon's SVG is written once, into a custom property that both
 * masks read, with only what draws it: about a third of the bytes. The license stays in the
 * package (lucide-static, ISC).
 */
function leanIcons() {
	const ICON = /^url\("?data:image\/svg\+xml;utf8,([^")]*)"?\)$/;
	return {
		postcssPlugin: "ponder-lean-icons",
		Rule(rule) {
			let svg;
			rule.walkDecls(/^(-webkit-)?mask-image$/, (decl) => {
				const match = ICON.exec(decl.value);
				if (!match) return;
				svg ??= leanSvg(decodeURIComponent(match[1]));
				decl.value = "var(--ponder-icon)";
			});
			if (svg) rule.prepend({ prop: "--ponder-icon", value: `url("data:image/svg+xml;utf8,${encodeSvg(svg)}")` });
		},
	};
}
leanIcons.postcss = true;

/**
 * The SVG without the comment, and without the class names, width and height of its root
 * <svg> (the viewBox sizes it). Only the root's: a <rect> needs its own width and height.
 */
function leanSvg(svg) {
	return svg
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<svg\b[^>]*>/, (root) => root.replace(/\s(class|width|height)="[^"]*"/g, ""))
		.replace(/\s+/g, " ")
		.replace(/\s*(\/?>)\s*/g, "$1")
		.trim();
}

/** A data URI's text, encoded only where it must be: double quotes become single, and %, #, < and > are escaped. */
function encodeSvg(svg) {
	return svg.replace(/"/g, "'").replace(/[%#<>]/g, encodeURIComponent);
}
