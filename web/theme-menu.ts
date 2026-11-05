import { useColorScheme } from "frappe-ui";
import { h } from "vue";

/**
 * The Theme item of an account menu (the chat's and /admin's): light, dark or the
 * device's setting, with a check on the one in use. frappe-ui keeps the choice in
 * localStorage. Call the returned function inside a computed menu, so the check follows.
 */
const THEMES = [
	{ label: "Light", value: "light", icon: "lucide-sun" },
	{ label: "Dark", value: "dark", icon: "lucide-moon" },
	{ label: "Same as device", value: "system", icon: "lucide-monitor" },
] as const;

export function useThemeMenu() {
	const { colorScheme, setColorScheme } = useColorScheme();
	return () => ({
		label: "Theme",
		icon: "lucide-sun-moon",
		submenu: THEMES.map((theme) => ({
			label: theme.label,
			icon: theme.icon,
			selected: colorScheme.value === theme.value,
			slots: {
				suffix: ({ selected }: { selected: boolean }) => (selected ? h("span", { class: "lucide-check size-4 shrink-0 text-ink-gray-7" }) : null),
			},
			onClick: () => setColorScheme(theme.value),
		})),
	});
}
