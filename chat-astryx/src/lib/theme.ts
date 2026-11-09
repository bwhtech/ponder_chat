import { createStore } from "./store";

/** Light, dark, or the device's own choice. Kept in this browser under "theme", as the Vue page did. */
export type ThemeMode = "light" | "dark" | "system";

const KEY = "theme";

function saved(): ThemeMode {
	try {
		const value = localStorage.getItem(KEY);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}

export const themeMode = createStore<ThemeMode>(saved());

themeMode.subscribe(() => {
	const mode = themeMode.get();
	try {
		if (mode === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, mode);
	} catch {
		// Private browsing: the choice lasts for this page only.
	}
});
