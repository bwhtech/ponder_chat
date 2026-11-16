/**
 * `npx tsx scripts/logo.ts`: draws Ponder's default logo and the icons made from it, into
 * web/public/. Run it again after a change here; the files it writes are committed.
 *
 * The logo is Lucide's message-square with a four-point sparkle in its corner, in one colour:
 * frappe-ui's ink-gray-8 on surface-base (light), and the same tokens' dark values (dark).
 * An admin can replace it in Settings, Branding (server/branding/Branding.ts).
 */
import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { semanticColors } from "frappe-ui/tailwind/tokens";

const OUT = "web/public";

// Lucide's message-square (ISC), on a 24-unit grid.
const BUBBLE = "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z";
// Fuller than Lucide's sparkle, which reads as a "+" at favicon size.
const SPARKLE = "M12 1.5C12.9 8.2 15.8 11.1 22.5 12C15.8 12.9 12.9 15.8 12 22.5C11.1 15.8 8.2 12.9 1.5 12C8.2 11.1 11.1 8.2 12 1.5Z";

type Look = { ink: string; tile: string; edge: string };

const light = semanticColors.light;
const dark = semanticColors.dark;
const LOOKS = {
	light: { ink: hex(light.ink["gray-8"]), tile: hex(light.surface.base), edge: hex(light.outline["gray-1"]) },
	dark: { ink: hex(dark.ink["gray-8"]), tile: hex(dark.surface["gray-1"]), edge: hex(dark.outline["gray-2"]) },
} satisfies Record<string, Look>;

/** The logo on a 512 tile. `rounded` false fills the square, for icons the system rounds itself (iOS). */
function logo({ ink, tile, edge }: Look, rounded = true) {
	const radius = rounded ? 116 : 0;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <mask id="gap" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
      <rect x="-2" y="-2" width="28" height="28" fill="#fff"/>
      <circle cx="19" cy="5" r="5.8" fill="#000"/>
    </mask>
  </defs>
  <rect width="512" height="512" rx="${radius}" fill="${tile}"/>
  ${rounded ? `<rect x="2" y="2" width="508" height="508" rx="114" fill="none" stroke="${edge}" stroke-width="4"/>` : ""}
  <g transform="translate(112 112) scale(12)" fill="none" stroke="${ink}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path mask="url(#gap)" d="${BUBBLE}"/>
    <g transform="translate(19 5) scale(0.46) translate(-12 -12)"><path fill="${ink}" stroke-width="2" d="${SPARKLE}"/></g>
  </g>
</svg>
`;
}

const png = (svg: string, size: number, file: string) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(`${OUT}/${file}`);

writeFileSync(`${OUT}/logo-light.svg`, logo(LOOKS.light));
writeFileSync(`${OUT}/logo-dark.svg`, logo(LOOKS.dark));
await Promise.all([
	png(logo(LOOKS.light), 64, "favicon.png"),
	png(logo(LOOKS.light, false), 180, "apple-touch-icon.png"),
	png(logo(LOOKS.light), 192, "icon-192.png"),
	png(logo(LOOKS.light), 512, "icon-512.png"),
]);
console.log(`logo: wrote ${OUT}/logo-light.svg, logo-dark.svg, favicon.png, apple-touch-icon.png, icon-192.png and icon-512.png`);

/** frappe-ui's tokens are oklch(L C H); SVG and PNG want sRGB. Through OKLab and linear sRGB, clipped to the gamut. */
function hex(oklch: string) {
	const [L, C, H = 0] = (oklch.match(/[\d.]+/g) ?? []).map(Number);
	const a = C * Math.cos((H * Math.PI) / 180);
	const b = C * Math.sin((H * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	const channel = (x: number) => {
		const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
		return Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${linear.map(channel).join("")}`;
}
