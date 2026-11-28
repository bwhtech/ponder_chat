import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures.ts";

/**
 * admin.html draws Overview's first screen before any code runs, with copies of the classes
 * the app uses. When the app mounts, its own loading screen replaces it. Here, every label
 * the copy draws must be where the app draws it, so nothing moves on the swap.
 */
const labels = ["Overview", "Requests", "Users", "Today", "Active people", "People out of credits", "Over time", "14 days", "Credits used per day", "Credits by model", "Who uses Ponder"];

for (const view of [
	{ name: "wide", viewport: { width: 1440, height: 900 }, isMobile: false },
	{ name: "phone", viewport: { width: 390, height: 844 }, isMobile: true },
]) {
	test(`/admin's first screen is where the app draws it (${view.name})`, async ({ admin, page, browser }) => {
		void admin;
		const state = await page.context().storageState();
		const context = await browser.newContext({ viewport: view.viewport, isMobile: view.isMobile, hasTouch: view.isMobile, storageState: state });
		const first = await context.newPage();
		// No code: only what admin.html draws.
		await first.route("**/*.js", (route) => route.abort());
		await first.goto("/admin/");
		const before = await positions(first);
		expect(Object.keys(before).sort()).toEqual([...labels].sort());

		// The app, with Overview's numbers still loading.
		const app = await context.newPage();
		await app.route("**/api/admin/overview**", () => {});
		await app.goto("/admin/");
		await expect(app.locator("#app[data-v-app]")).toBeAttached();
		await expect(app.getByText("Credits used per day")).toBeVisible();
		expect(await positions(app)).toEqual(before);
		await context.close();
	});
}

/** Where each label's text starts: the first one drawn, where a label shows twice. */
function positions(page: Page) {
	return page.evaluate((labels) => {
		const found: Record<string, string> = {};
		const texts = document.createTreeWalker(document.getElementById("app")!, NodeFilter.SHOW_TEXT);
		for (let node = texts.nextNode(); node; node = texts.nextNode()) {
			const text = node.textContent!.trim();
			const range = document.createRange();
			range.selectNodeContents(node);
			const box = range.getBoundingClientRect();
			if (!labels.includes(text) || text in found || !box.width) continue;
			found[text] = `${Math.round(box.x)},${Math.round(box.y)}`;
		}
		return found;
	}, labels);
}
