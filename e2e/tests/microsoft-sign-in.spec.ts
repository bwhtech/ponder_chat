import type { Browser, Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { expect, invite, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";
import { MICROSOFT_CLIENT_SECRET } from "../microsoft/server.ts";

/**
 * Sign in with Microsoft, in a browser: an admin sets it up in Settings, and people sign
 * in through the stand-in for Microsoft (microsoft/server.ts). The rules are tested in
 * server/auth/microsoft-sign-in.test.ts; this is the path through the pages.
 *
 * The setting is one for the whole server, which every test shares. So these tests run
 * one at a time, each leaves it off, and no other file changes it.
 */
test.describe.configure({ mode: "serial" });

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const DOMAIN = "contoso-e2e.example";
const HEADERS = { Origin: e2e.baseUrl };

const settings = { enabled: true, tenantId: TENANT, clientId: CLIENT_ID, clientSecret: MICROSOFT_CLIENT_SECRET, signUps: "invited", allowedDomains: [DOMAIN] };

/** Sets Microsoft sign-in through the admin API, as the dialog does. */
async function set(admin: Page, change: Partial<typeof settings> = {}) {
	const response = await admin.request.put("/api/admin/sign-in/microsoft", { data: { ...settings, ...change }, headers: HEADERS });
	expect(response.ok(), await response.text()).toBe(true);
}

const turnOff = (admin: Page) => set(admin, { enabled: false });

/**
 * A signed-out person's browser, on the sign-in page. With `signIn`, the page shows these ways to
 * sign in, as if the server had them: the page reads them from its boot data (server/boot-page.ts).
 */
async function visitor(browser: Browser, signIn?: { microsoft: boolean; email: boolean }) {
	const context = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	const page = await context.newPage();
	if (signIn)
		await page.route("/", async (route) => {
			const response = await route.fetch();
			const html = (await response.text()).replace(/"signIn":\{[^}]*\}/, `"signIn":${JSON.stringify(signIn)}`);
			expect(html).toContain(JSON.stringify(signIn));
			await route.fulfill({ response, body: html });
		});
	await page.goto("/");
	return { context, page };
}

/** From Ponder's sign-in page to Microsoft's, and through it as `email`. */
async function signInAtMicrosoft(page: Page, email: string) {
	await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
	await page.waitForURL((url) => url.origin === e2e.microsoftUrl);
	await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Next" }).click();
}

const person = (title: string) => uniqueEmail(title).replace("@example.com", `@${DOMAIN}`);

test("an admin sets up Microsoft in Settings, and an invited person signs in with it", async ({ page, admin, db, browser }) => {
	void admin;
	try {
		// Before: the sign-in page offers email only.
		const before = await visitor(browser);
		await expect(before.page.getByRole("button", { name: "Email me a link" })).toBeVisible();
		await expect(before.page.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
		await before.context.close();

		await page.goto("/admin/settings");
		const settingsDialog = page.getByRole("dialog").first();
		await settingsDialog.getByRole("tab", { name: "Sign-in" }).click();
		// Email is the only way in: its switch can't be turned off yet.
		await expect(settingsDialog.getByRole("switch", { name: "Sign in by email" })).toBeChecked();
		await expect(settingsDialog.getByRole("switch", { name: "Sign in by email" })).toBeDisabled();
		await expect(settingsDialog.getByRole("button", { name: "Configure" })).toHaveCount(0);
		// Turning Microsoft on asks for what it needs first.
		await settingsDialog.getByRole("switch", { name: "Sign in with Microsoft" }).click();

		const form = page.getByRole("dialog", { name: "Sign in with Microsoft" });
		// What the admin registers in Entra: this server's address.
		await expect(form.locator("[data-slot=redirect-uri]").first()).toHaveText(`${e2e.baseUrl}/api/auth/callback/microsoft`);
		await form.getByLabel("Directory (tenant) ID").fill(TENANT);
		await form.getByLabel("Application (client) ID").fill(CLIENT_ID);
		await form.getByLabel("Email domains").fill(DOMAIN);

		// The secret's ID is the easy one to copy from Entra, and it never works: the form says so at the field.
		await form.getByLabel("Client secret").fill("0f8fad5b-d9cb-469f-a165-70867728950e");
		await form.getByRole("button", { name: "Turn on" }).click();
		await expect(form.getByText("That is the secret's ID.", { exact: false })).toBeVisible();

		await form.getByLabel("Client secret").fill(MICROSOFT_CLIENT_SECRET);
		await form.getByRole("button", { name: "Turn on" }).click();
		await expect(page.getByRole("region", { name: /Notifications/ }).getByText("People can sign in with Microsoft")).toBeVisible();
		await expect(form).toHaveCount(0);
		await expect(settingsDialog.getByText(`For emails of ${DOMAIN}. A person still needs an invite.`)).toBeVisible();
		await expect(settingsDialog.getByRole("switch", { name: "Sign in with Microsoft" })).toBeChecked();
		// Email can go off once this admin has signed in with Microsoft, which shows it works. Configure changes Microsoft's settings.
		await expect(settingsDialog.getByRole("switch", { name: "Sign in by email" })).toBeDisabled();
		await expect(settingsDialog.getByText("To switch this off, sign in with Microsoft once.", { exact: false })).toBeVisible();
		await settingsDialog.getByRole("button", { name: "Configure" }).click();
		await expect(form.getByLabel("Directory (tenant) ID")).toHaveValue(TENANT);
		await form.getByRole("button", { name: "Cancel" }).click();
		await expect(form).toHaveCount(0);

		// The saved secret never comes back to the page.
		const saved = await page.request.get("/api/admin/sign-in");
		expect(await saved.text()).not.toContain(MICROSOFT_CLIENT_SECRET);

		const email = person("invited");
		await invite(db, email);
		const { context, page: theirs } = await visitor(browser);
		await signInAtMicrosoft(theirs, email);
		await expect(theirs.getByText("What's on your mind?")).toBeVisible();
		expect(new URL(theirs.url()).origin).toBe(e2e.baseUrl);
		await context.close();

		// The person's menu can unlink their Microsoft account, for when the directory makes it again.
		const [{ id }] = await db<{ id: string }[]>`select id from users where email = ${email}`;
		await page.goto(`/admin/people/${id}`);
		await page.getByRole("button", { name: "More actions" }).click();
		await page.getByRole("menuitem", { name: "Unlink Microsoft account" }).click();
		await page.getByRole("button", { name: "Unlink", exact: true }).click();
		await expect(page.getByText("Microsoft account", { exact: false }).first()).toBeVisible();
		await expect.poll(async () => (await db`select 1 from accounts where "userId" = ${id}`).length).toBe(0);
		await page.getByRole("button", { name: "More actions" }).click();
		await expect(page.getByRole("menuitem", { name: "Sign out everywhere" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Unlink Microsoft account" })).toHaveCount(0);
		await page.keyboard.press("Escape");

		// The log says what changed, and not the secret.
		await page.goto("/admin/activity");
		await expect(page.getByText("Unlinked their Microsoft account").first()).toBeVisible();
		await expect(page.getByText("Turned on sign-in with Microsoft").first()).toBeVisible();
		await expect(page.getByText("New client secret").first()).toBeVisible();
		await expect(page.getByText(MICROSOFT_CLIENT_SECRET)).toHaveCount(0);
	} finally {
		await turnOff(page);
	}
});

test("with email turned off, the sign-in page offers Microsoft only, until Microsoft goes off", async ({ page, admin, browser }) => {
	void admin;
	// Every test signs in by email (fixtures.ts), so this one never turns it off on the shared server:
	// it answers the page's request itself, and draws the sign-in page as the server would then.
	// server/auth/microsoft-sign-in.test.ts turns email off for real.
	try {
		await set(page);
		// As after this admin signed in with Microsoft (the fixtures' admin signs in by email).
		await page.route("**/api/admin/sign-in", async (route) => {
			const response = await route.fetch();
			const body: unknown = await response.json();
			if (typeof body !== "object" || body === null || !("email" in body)) throw new Error("GET /api/admin/sign-in: no email");
			await route.fulfill({ response, json: { ...body, email: { enabled: true, signedInWithMicrosoft: true } } });
		});
		await page.route("**/api/admin/sign-in/email", (route) => route.fulfill({ json: { email: { enabled: false, signedInWithMicrosoft: true } } }));
		await page.goto("/admin/settings");
		const settingsDialog = page.getByRole("dialog").first();
		await settingsDialog.getByRole("tab", { name: "Sign-in" }).click();
		const email = settingsDialog.getByRole("switch", { name: "Sign in by email" });
		await email.click();
		await expect(page.getByRole("region", { name: /Notifications/ }).getByText("Sign-in by email is off")).toBeVisible();
		await expect(email).not.toBeChecked();
		await expect(settingsDialog.getByText("Off. People sign in with Microsoft only.")).toBeVisible();

		const only = await visitor(browser, { microsoft: true, email: false });
		await expect(only.page.getByText("Use your Microsoft work account.")).toBeVisible();
		await expect(only.page.getByRole("button", { name: "Sign in with Microsoft" })).toBeVisible();
		await expect(only.page.getByRole("button", { name: "Email me a link" })).toHaveCount(0);
		await only.context.close();

		// Microsoft off: email is on again, so there is always a way in.
		await settingsDialog.getByRole("switch", { name: "Sign in with Microsoft" }).click();
		await expect(page.getByRole("region", { name: /Notifications/ }).getByText("Microsoft is off. Sign-in by email is on again.")).toBeVisible();
		await expect(email).toBeChecked();
		await expect(email).toBeDisabled();
	} finally {
		await turnOff(page);
	}
});

test("a person who was not invited, or who cancels, comes back to the sign-in page with the reason", async ({ page, admin, browser }) => {
	void admin;
	try {
		await set(page);
		const { context, page: theirs } = await visitor(browser);

		await signInAtMicrosoft(theirs, person("not invited"));
		await expect(theirs.getByText("This email is not invited to Ponder Chat.")).toBeVisible();
		// Shown once: the address is clean again, so a reload does not say it twice.
		expect(new URL(theirs.url()).search).toBe("");

		await theirs.getByRole("button", { name: "Sign in with Microsoft" }).click();
		await theirs.waitForURL((url) => url.origin === e2e.microsoftUrl);
		await theirs.getByRole("button", { name: "Cancel" }).click();
		await expect(theirs.getByText("The Microsoft sign-in was cancelled.")).toBeVisible();

		// An account of the tenant with an email of another domain, such as a guest.
		await signInAtMicrosoft(theirs, uniqueEmail("guest"));
		await expect(theirs.getByText("That Microsoft account's email is not of this organisation.", { exact: false })).toBeVisible();
		await context.close();
	} finally {
		await turnOff(page);
	}
});

test("set to everyone, a person of the organisation signs in with no invite, and lands on the page they opened", async ({ page, admin, browser }) => {
	void admin;
	try {
		await set(page, { signUps: "everyone" });
		const email = person("everyone");
		const context = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
		const theirs = await context.newPage();
		// A link to a chat, opened signed out: after the sign-in the address is the same.
		await theirs.goto("/?t=a-chat-someone-linked");
		await signInAtMicrosoft(theirs, email);
		await expect(theirs.getByText("What's on your mind?")).toBeVisible();
		expect(new URL(theirs.url()).searchParams.get("t")).toBe("a-chat-someone-linked");
		const me = await theirs.request.get("/api/me");
		expect(await me.text()).toContain(email);
		await context.close();
	} finally {
		await turnOff(page);
	}
});

test("turned off, the sign-in page offers email only again, and sign-in by email works as before", async ({ page, admin, db, fake, browser }) => {
	void admin;
	await set(page);
	await turnOff(page);
	const { context, page: theirs } = await visitor(browser);
	await expect(theirs.getByRole("button", { name: "Email me a link" })).toBeVisible();
	await expect(theirs.getByRole("button", { name: "Sign in with Microsoft" })).toHaveCount(0);
	await signIn(theirs, db, fake, uniqueEmail("by email"));
	await theirs.goto("/");
	await expect(theirs.getByText("What's on your mind?")).toBeVisible();
	await context.close();
});
