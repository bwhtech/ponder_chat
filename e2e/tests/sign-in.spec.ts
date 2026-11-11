import { expect, invite, signIn, test, uniqueEmail } from "../fixtures.ts";

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
