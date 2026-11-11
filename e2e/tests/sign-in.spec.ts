import { expect, invite, test, uniqueEmail } from "../fixtures.ts";

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

test("a wrong code does not sign in", async ({ page, db, fake }) => {
	const email = uniqueEmail("wrong code");
	await invite(db, email);

	await page.goto("/");
	await page.getByLabel("Email").fill(email);
	await page.getByRole("button", { name: "Email me a link" }).click();
	const code = await fake.signInCode(email);
	await page.getByLabel("Code").fill(code === "000000" ? "111111" : "000000");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByText("What's on your mind?")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});
