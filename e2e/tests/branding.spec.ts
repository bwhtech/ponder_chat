import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { expect, test } from "../fixtures.ts";

/** A logo no one would draw by accident: a teal square. */
const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#0d9488"/></svg>');

/** The logo image the page shows now: BrandLogo has one for each theme, and CSS hides the other. */
const shownLogo = (page: Page, where: string) => page.locator(`${where} img:visible`).first();

test("an admin sets the logo, and the chat, dark mode and the sign-in page show it", async ({ page, admin, browser }) => {
	void admin;
	try {
		await page.goto("/");
		await expect(shownLogo(page, "[data-slot=sidebar-header]")).toHaveAttribute("src", "/logo-light.svg");

		await page.goto("/admin/settings");
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("tab", { name: "Branding" }).click();
		await expect(dialog.getByText("Ponder's logo.").first()).toBeVisible();
		await dialog.getByLabel("Logo for light mode").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: LOGO });
		await expect(page.getByText("Logo saved")).toBeVisible();
		await expect(dialog.getByText(/^Your logo, set/)).toBeVisible();
		// Dark mode has no logo of its own, so it shows the light one.
		await expect(dialog.getByText(/^Your light-mode logo/)).toBeVisible();
		await expect(page.getByTestId("logo-preview-dark").locator("img")).toHaveAttribute("src", /^\/api\/brand\/logo\/light\?v=\d+$/);

		// The image is the upload, and opened on its own it can run nothing.
		const src = (await page.getByTestId("logo-preview-light").locator("img").getAttribute("src"))!;
		const image = await page.request.get(src);
		expect(image.headers()["content-type"]).toBe("image/svg+xml");
		expect(image.headers()["content-security-policy"]).toContain("sandbox");
		expect(image.headers()["cache-control"]).toContain("immutable");
		expect(Buffer.from(await image.body()).equals(LOGO)).toBe(true);

		await page.goto("/");
		await expect(shownLogo(page, "[data-slot=sidebar-header]")).toHaveAttribute("src", src);
		await page.evaluate(() => localStorage.setItem("theme", "dark"));
		await page.reload();
		await expect(shownLogo(page, "[data-slot=sidebar-header]")).toHaveAttribute("src", src);
		await page.evaluate(() => localStorage.removeItem("theme"));

		// Signed out, the sign-in page shows it too.
		const signedOut = await browser.newContext({ baseURL: e2e.baseUrl });
		const visitor = await signedOut.newPage();
		await visitor.goto("/");
		await expect(shownLogo(visitor, "main")).toHaveAttribute("src", src);
		await signedOut.close();

		await page.goto("/admin/settings");
		await page.getByRole("dialog").getByRole("tab", { name: "Branding" }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
		await expect(page.getByText("Back to Ponder's logo")).toBeVisible();
		await expect(page.getByTestId("logo-preview-light").locator("img")).toHaveAttribute("src", "/logo-light.svg");

		await page.goto("/admin/activity");
		await expect(page.getByText("Changed the logo for light mode").first()).toBeVisible();
		await expect(page.getByText("Removed the logo for light mode").first()).toBeVisible();
	} finally {
		for (const theme of ["light", "dark"]) await page.request.delete(`/api/admin/branding/logo/${theme}`, { headers: { Origin: e2e.baseUrl } });
	}
});

test("the server refuses an upload that is not an image", async ({ page, admin }) => {
	void admin;
	await page.goto("/admin/settings");
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("tab", { name: "Branding" }).click();
	await dialog.getByLabel("Logo for dark mode").setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<html>not an image</html>") });
	await expect(page.getByText("The logo can't be read. Upload an SVG, PNG, JPEG or WebP image.")).toBeVisible();
	await expect(dialog.getByText("Upload", { exact: true }).first()).toBeVisible();
});
