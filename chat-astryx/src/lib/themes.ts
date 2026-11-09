import type { DefinedTheme } from "@astryxdesign/core/theme";
import { butterTheme } from "@astryxdesign/theme-butter/built";
import { chocolateTheme } from "@astryxdesign/theme-chocolate/built";
import { gothicTheme } from "@astryxdesign/theme-gothic/built";
import { matchaTheme } from "@astryxdesign/theme-matcha/built";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { stoneTheme } from "@astryxdesign/theme-stone/built";
import { y2kTheme } from "@astryxdesign/theme-y2k/built";
import "@astryxdesign/theme-butter/theme.css";
import "@astryxdesign/theme-chocolate/theme.css";
import "@astryxdesign/theme-gothic/theme.css";
import "@astryxdesign/theme-matcha/theme.css";
import "@astryxdesign/theme-stone/theme.css";
import "@astryxdesign/theme-y2k/theme.css";
import type { ThemeName } from "./theme";

/** The built Astryx themes. Each theme's CSS is scoped to its own data-astryx-theme, so all load together. */
export const builtThemes: Record<ThemeName, DefinedTheme> = {
	neutral: neutralTheme,
	butter: butterTheme,
	chocolate: chocolateTheme,
	matcha: matchaTheme,
	stone: stoneTheme,
	gothic: gothicTheme,
	y2k: y2kTheme,
};

/** Each theme's web fonts, loaded only when the theme is picked. */
const fonts: Partial<Record<ThemeName, () => Promise<unknown>>> = {
	butter: () => import("@astryxdesign/theme-butter/fonts.css"),
	chocolate: () => import("@astryxdesign/theme-chocolate/fonts.css"),
	gothic: () => import("@astryxdesign/theme-gothic/fonts.css"),
	matcha: () => import("@astryxdesign/theme-matcha/fonts.css"),
	stone: () => import("@astryxdesign/theme-stone/fonts.css"),
	y2k: () => import("@astryxdesign/theme-y2k/fonts.css"),
};

export function loadFonts(name: ThemeName) {
	void fonts[name]?.().catch(() => undefined);
}
