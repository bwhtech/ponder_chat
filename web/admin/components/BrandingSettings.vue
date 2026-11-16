<script setup lang="ts">
import { Button, SettingsRow, toast } from "frappe-ui";
import { reactive, ref } from "vue";
import { logos, logoUrl, setLogos, type LogoVersions, type Theme } from "../../brand";
import { when } from "../../dates";

/**
 * The organisation's logo, for light and dark mode (server/branding/Branding.ts). An upload
 * or a removal saves at once. The values are in brand.ts, which main.ts loaded before the
 * app was drawn, so this panel has no loading state.
 */
const MAX_BYTES = 1024 * 1024;
const ACCEPT = "image/svg+xml,image/png,image/jpeg,image/webp";

const ROWS: { theme: Theme; title: string }[] = [
	{ theme: "light", title: "Light mode" },
	{ theme: "dark", title: "Dark mode" },
];

const busy = reactive<Record<Theme, "upload" | "remove" | null>>({ light: null, dark: null });
const inputs = ref<Partial<Record<Theme, HTMLInputElement>>>({});

function description(theme: Theme) {
	const version = logos[theme];
	if (version !== null) return `Your logo, set ${when(new Date(version).toISOString())}.`;
	if (theme === "dark" && logos.light !== null) return "Your light-mode logo. Upload one for dark mode if it does not show well on a dark background.";
	return "Ponder's logo.";
}

async function upload(theme: Theme, event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	// The same file again must fire change again.
	input.value = "";
	if (!file) return;
	if (file.size > MAX_BYTES) return void toast.error("The logo is larger than 1 MB.");
	const body = new FormData();
	body.append("file", file);
	await change(theme, "upload", () => fetch(`/api/admin/branding/logo/${theme}`, { method: "PUT", body }), "Logo saved");
}

function remove(theme: Theme) {
	return change(theme, "remove", () => fetch(`/api/admin/branding/logo/${theme}`, { method: "DELETE" }), theme === "dark" ? "Dark mode uses the light-mode logo" : "Back to Ponder's logo");
}

async function change(theme: Theme, kind: "upload" | "remove", send: () => Promise<Response>, done: string) {
	busy[theme] = kind;
	try {
		const response = await send();
		const answer = (await response.json().catch(() => ({}))) as { logos?: LogoVersions; error?: string };
		if (!response.ok || !answer.logos) throw new Error(answer.error ?? "The logo could not be saved. Try again.");
		setLogos(answer.logos);
		toast.success(done);
	} catch (error) {
		toast.error(error instanceof Error && error.message !== "Failed to fetch" ? error.message : "The logo could not be saved. Try again.");
	} finally {
		busy[theme] = null;
	}
}
</script>

<template>
	<div class="space-y-8 pt-4">
		<section class="space-y-3">
			<h2 class="text-base-semibold text-ink-gray-9">Logo</h2>
			<p class="text-p-sm text-ink-gray-6">
				Shows for everyone: in the sidebar, on the sign-in page and on the browser tab. A square image works best: an SVG, or a PNG of 128px or more, up to 1 MB.
			</p>
			<div class="divide-y divide-outline-gray-1">
				<SettingsRow v-for="row in ROWS" :key="row.theme" :title="row.title" :description="description(row.theme)">
					<div class="flex items-center gap-2 [@media(pointer:coarse)]:gap-x-3">
						<!-- Each mode's sidebar colour, whatever the page's theme, so the logo shows as people will see it. -->
						<div
							class="mr-1 grid size-11 shrink-0 place-items-center rounded-7 border"
							:class="row.theme === 'dark' ? 'border-[#383838] bg-[#1a1a1a]' : 'border-[#ededed] bg-[#f8f8f8]'"
							:data-testid="`logo-preview-${row.theme}`"
						>
							<img :src="logoUrl(row.theme)" alt="" class="size-7 rounded-[6px] object-contain" />
						</div>
						<input
							:ref="(element) => (inputs[row.theme] = element as HTMLInputElement)"
							type="file"
							:accept="ACCEPT"
							class="hidden"
							:aria-label="`Logo for ${row.title.toLowerCase()}`"
							@change="upload(row.theme, $event)"
						/>
						<Button
							class="touch-target"
							:label="logos[row.theme] === null ? 'Upload' : 'Replace'"
							:loading="busy[row.theme] === 'upload'"
							:disabled="busy[row.theme] !== null"
							@click="inputs[row.theme]?.click()"
						/>
						<Button
							v-if="logos[row.theme] !== null"
							variant="ghost"
							class="touch-target"
							label="Remove"
							:loading="busy[row.theme] === 'remove'"
							:disabled="busy[row.theme] !== null"
							@click="remove(row.theme)"
						/>
					</div>
				</SettingsRow>
			</div>
		</section>
	</div>
</template>
