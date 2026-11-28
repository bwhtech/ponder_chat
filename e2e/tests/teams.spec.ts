import type { Locator, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { expect, jsonOf, test } from "../fixtures.ts";
import { createWorkspace, newPerson } from "../workspaces.ts";

/**
 * Teams in /admin (server/teams/, web/admin/pages/Teams.vue and Team.vue): an org admin
 * makes a team with its first team admin, adds people with a role, changes roles, removes
 * people and renames the team, archives, restores and deletes it. Each change is in the
 * activity log. Settings > Teams shows a person their own teams.
 */
const headers = { Origin: e2e.baseUrl };
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Picks a person in a people search by their email. */
async function pick(page: Page, field: Locator, email: string) {
	await field.fill(email);
	await page.getByRole("option", { name: new RegExp(escape(email)) }).click();
}

const memberRow = (page: Page, email: string) => page.locator(`[data-member="${email}"]`);

test("an org admin makes a team, adds people with a role, changes roles, removes people and renames it", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const mark = randomBytes(3).toString("hex");
	const name = `Human resources ${mark}`;
	const [lead, helper] = await Promise.all([newPerson(browser, db, fake, "team lead"), newPerson(browser, db, fake, "team helper")]);

	await page.goto("/admin/teams");
	await expect(page.getByRole("heading", { name: "Teams", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "New team" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: /^Name/ }).fill(name);
	await dialog.getByLabel("Description").fill("People and pay");
	await dialog.getByRole("button", { name: "Create" }).click();
	await expect(dialog.getByText("Pick the person who manages the team.")).toBeVisible();
	await pick(page, dialog.getByRole("combobox", { name: "Search people by name or email" }), lead.person.email);
	await expect(dialog.getByText(lead.person.email)).toBeVisible();
	await dialog.getByRole("button", { name: "Create" }).click();

	await expect(page).toHaveURL(/\/admin\/teams\/[^/]+$/);
	await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
	await expect(page.getByText("People and pay")).toBeVisible();
	await expect(memberRow(page, lead.person.email).getByText("Team admin")).toBeVisible();

	// Add a member: the role picked is Member.
	await pick(page, page.getByRole("combobox", { name: "Add people by name or email" }), helper.person.email);
	await expect(page.getByText(new RegExp(`Added .* as a member`))).toBeVisible();
	await expect(memberRow(page, helper.person.email)).toBeVisible();
	await expect(memberRow(page, helper.person.email).getByText("Team admin")).toHaveCount(0);
	await expect(page.getByText("2 members · 1 team admin")).toBeVisible();

	// Make them a team admin, then remove them.
	await memberRow(page, helper.person.email).getByRole("button", { name: /^Actions for / }).click();
	await page.getByRole("menuitem", { name: "Make team admin" }).click();
	await expect(memberRow(page, helper.person.email).getByText("Team admin")).toBeVisible();
	await memberRow(page, helper.person.email).getByRole("button", { name: /^Actions for / }).click();
	await page.getByRole("menuitem", { name: "Remove from team" }).click();
	await expect(memberRow(page, helper.person.email)).toHaveCount(0);

	// The page shows the change after a reload, too.
	await page.reload();
	await expect(memberRow(page, lead.person.email)).toBeVisible();
	await expect(memberRow(page, helper.person.email)).toHaveCount(0);

	// Rename it.
	await page.getByRole("button", { name: "Edit" }).click();
	await page.getByRole("dialog").getByRole("textbox", { name: /^Name/ }).fill(`HR ${mark}`);
	await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("heading", { name: `HR ${mark}`, exact: true })).toBeVisible();

	// The list has it with its counts.
	await page.getByRole("link", { name: "Teams" }).first().click();
	const row = page.locator(`[data-team="HR ${mark}"]`);
	await expect(row).toContainText("People and pay");
	await expect(row).toContainText("1");

	// The activity log names each change.
	await page.goto(`/admin/activity?person=${encodeURIComponent(helper.person.id)}`);
	await expect(page.getByText(`Added them to “${name}” as a member`)).toBeVisible();
	await expect(page.getByText(`Made them a team admin of “${name}”`)).toBeVisible();
	await expect(page.getByText(`Removed them from “${name}”`)).toBeVisible();

	await Promise.all([lead.context.close(), helper.context.close()]);
});

test("a team name is unique, in any case", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const lead = await newPerson(browser, db, fake, "unique lead");
	const name = `Finance ${randomBytes(3).toString("hex")}`;
	const first = await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers });
	expect(first.status(), await first.text()).toBe(201);

	await page.goto("/admin/teams");
	await page.getByRole("button", { name: "New team" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("textbox", { name: /^Name/ }).fill(name.toUpperCase());
	await pick(page, dialog.getByRole("combobox", { name: "Search people by name or email" }), lead.person.email);
	await dialog.getByRole("button", { name: "Create" }).click();
	await expect(page.getByText("A team with this name already exists.")).toBeVisible();
	await expect(dialog).toBeVisible();
	await lead.context.close();
});

test("a person who is not an org admin can't open the teams pages or their API", async ({ page, person }) => {
	void person;
	await page.goto("/admin/teams");
	await expect(page.getByRole("heading", { name: "This page is for admins" })).toBeVisible();
	expect((await page.request.get("/api/admin/teams")).status()).toBe(403);
	expect((await page.request.post("/api/admin/teams", { data: { name: "Mine", adminUserId: person.id }, headers })).status()).toBe(403);
});

test("on a phone, Teams is under More, and a team's page works", async ({ page, admin, browser, db, fake }) => {
	void admin;
	const lead = await newPerson(browser, db, fake, "phone lead");
	const name = `Support ${randomBytes(3).toString("hex")}`;
	const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId: lead.person.id }, headers });
	expect(made.status(), await made.text()).toBe(201);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/admin");
	await page.getByRole("button", { name: "More" }).click();
	await page.getByRole("menuitem", { name: "Teams" }).click();
	await expect(page).toHaveURL(/\/admin\/teams$/);
	await page.getByText(name, { exact: true }).click();
	// The phone header has the name too.
	await expect(page.getByRole("heading", { name, exact: true }).last()).toBeVisible();
	await expect(memberRow(page, lead.person.email).getByText("Team admin")).toBeVisible();
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width, "no sideways scroll").toBeLessThanOrEqual(390);
	await lead.context.close();
});

test("an org admin archives a team, restores it, then archives and deletes it, and each is in the activity log", async ({ page, admin, browser, db, fake }) => {
	test.setTimeout(90_000);
	const mark = randomBytes(3).toString("hex");
	const name = `Short lived ${mark}`;
	const member = await newPerson(browser, db, fake, "short member");
	const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId: admin.id }, headers });
	expect(made.status(), await made.text()).toBe(201);
	const { team } = await jsonOf<{ team: { id: string } }>(made);
	expect((await page.request.put(`/api/admin/teams/${team.id}/members/${member.person.id}`, { data: { role: "member" }, headers })).ok()).toBe(true);
	const workspace = await createWorkspace(page, `Grant ${mark}`);
	expect((await page.request.put(`/api/workspaces/${workspace.id}/teams/${team.id}`, { data: { access: "ask" } })).ok()).toBe(true);

	await page.goto(`/admin/teams/${team.id}`);
	const dialog = page.getByRole("dialog");
	await test.step("Archive asks first, then the team is read-only", async () => {
		await page.getByRole("button", { name: "Archive team" }).click();
		await expect(dialog.getByText("Its 1 workspace grant stop giving access, but stay.", { exact: false })).toBeVisible();
		await dialog.getByRole("button", { name: "Archive" }).click();
		await expect(page.getByText(`Archived ${name}`)).toBeVisible();
		await expect(page.getByText("Archived", { exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Add people" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
		await expect(memberRow(page, member.person.email).getByRole("button", { name: /^Actions for / })).toHaveCount(0);
	});

	await test.step("Restore brings it back", async () => {
		await page.getByRole("button", { name: "Restore team" }).click();
		await expect(page.getByRole("heading", { name: "Add people" })).toBeVisible();
		await expect(page.getByText("Archived", { exact: true })).toHaveCount(0);
	});

	await test.step("Delete is for an archived team, and names what goes", async () => {
		await expect(page.getByRole("button", { name: "Delete team" })).toHaveCount(0);
		await page.getByRole("button", { name: "Archive team" }).click();
		await dialog.getByRole("button", { name: "Archive" }).click();
		await page.getByRole("button", { name: "Delete team" }).click();
		await expect(dialog.getByText("This deletes the team with its 2 members, 1 workspace grant and 0 invites. You can't undo this.")).toBeVisible();
		await dialog.getByRole("button", { name: "Delete team" }).click();
		await expect(page).toHaveURL(/\/admin\/teams$/);
		await expect(page.locator(`[data-team="${name}"]`)).toHaveCount(0);
	});

	await page.goto(`/admin/activity?person=${encodeURIComponent(admin.id)}`);
	await expect(page.getByText(`Archived the team “${name}”`)).toHaveCount(2);
	await expect(page.getByText(`Restored the team “${name}”`)).toBeVisible();
	await expect(page.getByText(`Deleted the team “${name}”`)).toBeVisible();
	await expect(page.getByText("2 members · 1 workspace grant · 0 invites")).toBeVisible();
	await member.context.close();
});

test("Settings > Teams lists my active teams with their members, Manage for those I admin, and an empty state", async ({ page, admin, browser, db, fake }) => {
	test.setTimeout(90_000);
	const mark = randomBytes(3).toString("hex");
	const [lead, loner] = await Promise.all([newPerson(browser, db, fake, "settings lead"), newPerson(browser, db, fake, "settings loner")]);
	const teamOf = async (name: string, adminUserId: string, memberIds: string[] = []) => {
		const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId }, headers });
		expect(made.status(), await made.text()).toBe(201);
		const { team } = await jsonOf<{ team: { id: string } }>(made);
		for (const userId of memberIds) expect((await page.request.put(`/api/admin/teams/${team.id}/members/${userId}`, { data: { role: "member" }, headers })).ok()).toBe(true);
		return team.id;
	};
	const led = await teamOf(`Led ${mark}`, lead.person.id);
	await teamOf(`Joined ${mark}`, admin.id, [lead.person.id]);
	const gone = await teamOf(`Gone ${mark}`, admin.id, [lead.person.id]);
	expect((await page.request.post(`/api/admin/teams/${gone}/archive`, { headers })).ok()).toBe(true);

	const openTeams = async (who: Page) => {
		await who.goto("/");
		await who.getByRole("button", { name: /Ponder Chat/ }).first().click();
		await who.getByRole("menuitem", { name: "Settings" }).click();
		const settings = who.getByRole("dialog", { name: "Settings" });
		await settings.getByRole("tab", { name: "Teams" }).click();
		await expect(settings.getByRole("heading", { name: "Teams" })).toBeVisible();
		return settings;
	};

	const settings = await openTeams(lead.page);
	const ledCard = settings.locator(`[data-team="Led ${mark}"]`);
	const joinedCard = settings.locator(`[data-team="Joined ${mark}"]`);
	await expect(ledCard.getByRole("link", { name: "Manage" })).toHaveAttribute("href", `/admin/teams/${led}`);
	await expect(joinedCard.locator(`[data-member="${admin.email}"]`).getByText("Team admin")).toBeVisible();
	await expect(joinedCard.locator(`[data-member="${lead.person.email}"]`)).toBeVisible();
	await expect(joinedCard.getByRole("link", { name: "Manage" })).toHaveCount(0);
	await expect(settings.locator(`[data-team="Gone ${mark}"]`)).toHaveCount(0);

	await test.step("on a phone, in dark mode, it fits", async () => {
		await lead.page.setViewportSize({ width: 390, height: 844 });
		await lead.page.emulateMedia({ colorScheme: "dark" });
		await expect(ledCard).toBeVisible();
		const width = await lead.page.evaluate(() => document.documentElement.scrollWidth);
		expect(width, "no sideways scroll").toBeLessThanOrEqual(390);
	});

	const empty = await openTeams(loner.page);
	await expect(empty.getByText("You're in no team yet")).toBeVisible();
	await Promise.all([lead.context.close(), loner.context.close()]);
});
