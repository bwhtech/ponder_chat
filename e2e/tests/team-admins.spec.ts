import type { Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { expect, jsonOf, signIn, test, uniqueEmail } from "../fixtures.ts";
import { newPerson } from "../workspaces.ts";

/**
 * Team admins (docs/teams-plan.md, ticket 2): the chat's Admin item opens /admin on Teams,
 * the shell has only Teams, and every other page and API answers no. On their team's page
 * they add people by email or invite new emails, and cancel invites. An invited email
 * joins the team at its first sign-in. The emails go to the fake (e2e/fake/server.ts).
 */
const headers = { Origin: e2e.baseUrl };
type Team = { team: { id: string; members: { email: string; role: string }[]; invites: { email: string }[] } };

const memberRow = (page: Page, email: string) => page.locator(`[data-member="${email}"]`);
const inviteRow = (page: Page, email: string) => page.locator(`[data-invite="${email}"]`);

test("a team admin opens /admin from the chat and sees only their teams", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const name = `Hiring ${randomBytes(3).toString("hex")}`;
	const lead = await newPerson(browser, db, fake, "team admin lead");
	const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers });
	expect(made.status(), await made.text()).toBe(201);
	const added = await fake.email(lead.person.email);
	expect(added.subject).toBe(`You were added to ${name}`);
	expect(added.text).toContain(`You were added to ${name} as a team admin by`);

	await lead.page.goto("/");
	await lead.page.getByRole("button", { name: /Ponder Chat/ }).first().click();
	await lead.page.getByRole("menuitem", { name: "Admin" }).click();
	await expect(lead.page).toHaveURL(/\/admin\/teams$/);
	await expect(lead.page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
	await expect(lead.page.locator(`[data-team="${name}"]`)).toBeVisible();
	await expect(lead.page.getByRole("button", { name: "New team" })).toHaveCount(0);
	for (const other of ["Overview", "People", "Skills", "Activity"]) await expect(lead.page.getByRole("link", { name: other, exact: true })).toHaveCount(0);

	// Another page: NoAccess in the shell, and its API answers no.
	await lead.page.goto("/admin/people");
	await expect(lead.page.getByRole("heading", { name: "This page is for org admins" })).toBeVisible();
	expect((await lead.page.request.get("/api/admin/people")).status()).toBe(403);
	await lead.page.getByRole("link", { name: "Your teams" }).click();
	await expect(lead.page).toHaveURL(/\/admin\/teams$/);

	// A person who admins no team sees no Admin item.
	const plain = await newPerson(browser, db, fake, "no team");
	await plain.page.goto("/");
	await plain.page.getByRole("button", { name: /Ponder Chat/ }).first().click();
	await expect(plain.page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
	await expect(plain.page.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
	await Promise.all([lead.context.close(), plain.context.close()]);
});

test("a team admin adds people by email, invites a new email, and cancels the invite", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const name = `Payroll ${randomBytes(3).toString("hex")}`;
	const [lead, colleague] = await Promise.all([newPerson(browser, db, fake, "payroll lead"), newPerson(browser, db, fake, "payroll colleague")]);
	const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers });
	const { team } = await jsonOf<Team>(made);

	await lead.page.goto(`/admin/teams/${team.id}`);
	const field = lead.page.getByRole("textbox", { name: "Email to add or invite" });

	// An email with an account: added at once, and told.
	await field.fill(colleague.person.email.toUpperCase());
	await lead.page.getByRole("button", { name: "Add by email" }).click();
	await expect(memberRow(lead.page, colleague.person.email)).toBeVisible();
	await expect(field).toHaveValue("");
	expect((await fake.email(colleague.person.email)).text).toContain(`You were added to ${name} as a member by`);

	// A new email: invited, as a team admin.
	const newcomer = uniqueEmail("payroll newcomer");
	await lead.page.getByRole("combobox", { name: "Role for the people you add" }).click();
	await lead.page.getByRole("option", { name: "Team admin" }).click();
	await field.fill(newcomer);
	await field.press("Enter");
	await expect(inviteRow(lead.page, newcomer)).toBeVisible();
	await expect(inviteRow(lead.page, newcomer).getByText("Team admin")).toBeVisible();
	const invite = await fake.email(newcomer);
	expect(invite.subject).toBe("You are invited to Ponder Chat");
	expect(invite.text).toContain(`invited you to the team “${name}”`);
	const [allowed] = await db<{ team_only: boolean }[]>`select team_only from allowed_emails where email = ${newcomer}`;
	expect(allowed?.team_only).toBe(true);

	// Cancel it: the email may no longer sign in.
	await inviteRow(lead.page, newcomer).getByRole("button", { name: `Actions for ${newcomer}` }).click();
	await lead.page.getByRole("menuitem", { name: "Cancel invite" }).click();
	await expect(inviteRow(lead.page, newcomer)).toHaveCount(0);
	expect(await db`select 1 from allowed_emails where email = ${newcomer}`).toHaveLength(0);

	// The activity log, for the org admin.
	await page.goto(`/admin/activity?person=${encodeURIComponent(newcomer)}`);
	await expect(page.getByText(`Invited them to “${name}” as a team admin`)).toBeVisible();
	await expect(page.getByText(`Cancelled their invite to “${name}”`)).toBeVisible();
	await Promise.all([lead.context.close(), colleague.context.close()]);
});

test("an invited email joins the team at its first sign-in", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const name = `Legal ${randomBytes(3).toString("hex")}`;
	const lead = await newPerson(browser, db, fake, "legal lead");
	const { team } = await jsonOf<Team>(await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers }));
	const newcomer = uniqueEmail("legal newcomer");
	const invited = await lead.page.request.post(`/api/admin/teams/${team.id}/invites`, { data: { email: newcomer, role: "member" }, headers });
	expect(await jsonOf<{ invited?: boolean }>(invited)).toMatchObject({ invited: true });

	const context = await browser.newContext({ baseURL: e2e.baseUrl });
	await signIn(await context.newPage(), db, fake, newcomer);
	const after = await jsonOf<Team>(await lead.page.request.get(`/api/admin/teams/${team.id}`));
	expect(after.team.members.map((member) => [member.email, member.role])).toContainEqual([newcomer, "member"]);
	expect(after.team.invites).toEqual([]);
	await Promise.all([lead.context.close(), context.close()]);
});

test("on a phone, a team admin's tab bar has Teams and Chat, and the team's page fits", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const name = `Support ${randomBytes(3).toString("hex")}`;
	const lead = await newPerson(browser, db, fake, "phone team admin");
	const { team } = await jsonOf<Team>(await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers }));

	await lead.page.setViewportSize({ width: 390, height: 844 });
	await lead.page.goto("/admin");
	await expect(lead.page).toHaveURL(/\/admin\/teams$/);
	const nav = lead.page.locator('[data-slot="mobile-nav-item"]');
	await expect(nav).toHaveText(["Teams", "Chat"]);
	await lead.page.getByText(name, { exact: true }).click();
	await expect(lead.page).toHaveURL(new RegExp(`/admin/teams/${team.id}$`));
	await expect(lead.page.getByRole("button", { name: "Add by email" })).toBeVisible();
	const width = await lead.page.evaluate(() => document.documentElement.scrollWidth);
	expect(width, "no sideways scroll").toBeLessThanOrEqual(390);
	await lead.context.close();
});
