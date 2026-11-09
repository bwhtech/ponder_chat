import { createStore } from "./store";

/**
 * How the page looks: an Astryx theme (palette, type, icons, shapes) and a colour mode.
 * Both are kept in this browser. The mode uses the key the Vue page used ("theme").
 */
export type ThemeMode = "light" | "dark" | "system";
export type ThemeName = "neutral" | "butter" | "chocolate" | "matcha" | "stone" | "gothic" | "y2k";

export const THEMES: { name: ThemeName; label: string; description: string }[] = [
	{ name: "matcha", label: "Matcha", description: "Earthy greens, calm and organic" },
	{ name: "chocolate", label: "Chocolate", description: "Rich browns with a serif for headings" },
	{ name: "stone", label: "Stone", description: "Warm stone and slate, understated" },
	{ name: "butter", label: "Butter", description: "Creamy yellows with a blue accent" },
	{ name: "gothic", label: "Gothic", description: "Deep blue-grays, dramatic and editorial" },
	{ name: "y2k", label: "Y2K", description: "Hot pink and lime, bubbly and retro" },
	{ name: "neutral", label: "Neutral", description: "Plain grays" },
];

export const DEFAULT_THEME: ThemeName = "matcha";

const MODE_KEY = "theme";
const NAME_KEY = "ponder-chat:astryx-theme";

function read(key: string) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// Private browsing: the choice lasts for this page only.
	}
}

const savedMode = read(MODE_KEY);
export const themeMode = createStore<ThemeMode>(savedMode === "light" || savedMode === "dark" ? savedMode : "system");
themeMode.subscribe(() => write(MODE_KEY, themeMode.get() === "system" ? null : themeMode.get()));

const savedName = read(NAME_KEY);
export const themeName = createStore<ThemeName>(THEMES.some((theme) => theme.name === savedName) ? (savedName as ThemeName) : DEFAULT_THEME);
themeName.subscribe(() => write(NAME_KEY, themeName.get()));
