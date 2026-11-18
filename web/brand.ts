import { reactive } from "vue";
import { fromBoot } from "./boot";
import { isRecord } from "./json";

/**
 * The logo the pages show: the organisation's own when an admin set one (Settings, Branding),
 * else Ponder's (web/public/logo-light.svg and logo-dark.svg, drawn by scripts/logo.ts). Dark
 * mode without its own logo shows the light one, as the server says (server/branding/Branding.ts).
 *
 * The chat page has the versions in its boot data; /admin and `npm run dev` ask GET /api/brand.
 * Each version is in the image's address, so a browser keeps an image until the logo changes.
 */
export type Theme = "light" | "dark";
/** For each theme, when an admin set its logo (ms), or null for Ponder's. */
export type LogoVersions = Record<Theme, number | null>;

const PONDER: Record<Theme, string> = { light: "/logo-light.svg", dark: "/logo-dark.svg" };

export const logos = reactive<LogoVersions>({ light: null, dark: null });

/** The image for a theme. */
export function logoUrl(theme: Theme) {
	const own = theme === "dark" && logos.dark === null ? "light" : theme;
	const version = logos[own];
	return version === null ? PONDER[theme] : `/api/brand/logo/${own}?v=${version}`;
}

/** The tab's icon: the organisation's light logo, or Ponder's favicon. attention.ts draws its badge on it. */
export function faviconUrl() {
	return logos.light === null ? "/favicon.png" : logoUrl("light");
}

let loading: Promise<void> | undefined;

/** Reads which logos are set, once. Never fails: without an answer the pages show Ponder's logo. */
export function loadLogos() {
	loading ??= (async () => {
		const boot = fromBoot("logos");
		if (boot) return setLogos(boot);
		try {
			const response = await fetch("/api/brand");
			const body: unknown = response.ok ? await response.json() : undefined;
			if (isRecord(body) && isLogoVersions(body.logos)) setLogos(body.logos);
		} catch {
			// Offline: Ponder's logo, which the page has already.
		}
	})();
	return loading;
}

/** After a change on /admin, or once loaded. Also points the tab's icon at the logo. */
export function setLogos(next: LogoVersions) {
	Object.assign(logos, next);
	const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (link) link.href = faviconUrl();
}

/** An answer's logos: /api/brand's, or an admin's change (BrandingSettings.vue). */
export function isLogoVersions(value: unknown): value is LogoVersions {
	return isRecord(value) && [value.light, value.dark].every((version) => version === null || typeof version === "number");
}
