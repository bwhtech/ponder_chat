import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import { expect, invite, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";

test("signs in with the code from the email", async ({ page, db, fake }) => {
	const email = uniqueEmail("code");
	await invite(db, email);

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	await expect(page.getByText(`We sent a code to ${email}`)).toBeVisible();

	await page.getByLabel("Code").fill(await fake.signInCode(email));
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("What's on your mind?")).toBeVisible();
});

test("signs in with the link in the email", async ({ page, db, fake }) => {
	const email = uniqueEmail("link");
	await invite(db, email);

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	const { text } = await fake.email(email);
	await page.goto(text.match(/https?:\/\/\S+/)![0]);
	await expect(page.getByText("What's on your mind?")).toBeVisible();
});

test("sends no email to an address that was not invited", async ({ page, fake }) => {
	const email = uniqueEmail("not invited");

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	// The page looks the same either way, so it does not tell who is invited.
	await expect(page.getByText(`We sent a code to ${email}`)).toBeVisible();
	await page.waitForTimeout(500);
	expect(await fake.emails(email)).toEqual([]);
});

test("a link that was already used goes back to the sign-in page with a message", async ({ page, db, fake }) => {
	const email = uniqueEmail("used link");
	await invite(db, email);

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	const link = (await fake.email(email)).text.match(/https?:\/\/\S+/)![0];
	await page.goto(link);
	await expect(page.getByText("What's on your mind?")).toBeVisible();

	// The second time, auth.ts sends the person back to the page, not to an error in JSON.
	await page.context().clearCookies();
	await page.goto(link);
	await expect(page.getByText("That link has expired or was already used. Ask for a new one.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Email me a link" })).toBeVisible();
});

test("a blocked person can't sign in", async ({ page, db, fake }) => {
	const email = uniqueEmail("blocked");
	const person = await signIn(page, db, fake, email);
	await page.context().clearCookies();
	await db`update users set banned = true where id = ${person.id}`;

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	// The second email: the first one signed the person in before they were blocked.
	await expect.poll(async () => (await fake.emails(email)).length).toBe(2);
	await page.getByLabel("Code").fill(await fake.signInCode(email));
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("This account is blocked. Ask the person who invited you.")).toBeVisible();
	await expect(page.getByText("What's on your mind?")).toHaveCount(0);
});

test("a code is checked only by signing in with it", async ({ page, db, fake }) => {
	const email = uniqueEmail("check route");
	await invite(db, email);
	expect((await post(page, "/email-otp/send-verification-otp", { email, type: "sign-in" })).ok()).toBe(true);
	const code = await fake.signInCode(email);

	// Better Auth's route to check a code lost count of wrong codes that came together. It is off, for the right code too.
	const guesses = [...Array.from({ length: 40 }, (_, guess) => String(guess).padStart(6, "0")), code];
	const answers = await Promise.all(guesses.map((otp) => post(page, "/email-otp/check-verification-otp", { email, type: "sign-in", otp })));
	expect([...new Set(answers.map((answer) => answer.status()))]).toEqual([404]);

	expect((await post(page, "/sign-in/email-otp", { email, otp: code })).ok()).toBe(true);
});

test("stores no code of a type other than sign-in", async ({ page, db, fake }) => {
	const { email } = await signIn(page, db, fake, uniqueEmail("code types"));
	const stored = async () => (await db`select identifier from verifications where identifier like ${`%${email}`}`).map((row) => row.identifier);

	// A stored code would show, by how wrong guesses are answered, that the email has an account.
	for (const type of ["email-verification", "forget-password"]) {
		const answer = await post(page, "/email-otp/send-verification-otp", { email, type });
		expect(answer.status()).toBe(200);
		expect(await answer.json()).toEqual({ success: true });
	}
	expect(await stored()).toEqual([]);

	expect((await post(page, "/email-otp/send-verification-otp", { email, type: "sign-in" })).ok()).toBe(true);
	expect(await stored()).toEqual([`sign-in-otp-${email}`]);
	expect(await fake.emails(email)).toHaveLength(2);
});

/** A request to the sign-in API from an address of its own, so the limits per address do not answer. */
function post(page: Page, path: string, data: unknown) {
	return page.request.post(`/api/auth${path}`, { data, headers: { origin: e2e.baseUrl, "cf-connecting-ip": randomIp() } });
}
