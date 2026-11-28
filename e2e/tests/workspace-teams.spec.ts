import type { Locator, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { e2e } from "../env.ts";
import { expect, jsonOf, test } from "../fixtures.ts";
import { createWorkspace, newPerson } from "../workspaces.ts";

/**
 * Team grants on workspaces (docs/teams-plan.md, ticket 3): Share finds teams and people, a
 * team added gives every member its access at once, its role changes and it is removed as a
 * person's is. An archived team's grant is greyed out and has only Remove. Teams are made
 * and archived through the admin API.
 */
const headers = { Origin: e2e.baseUrl };
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A team made by the page's person, an org admin, with its first admin and its members. */
async function makeTeam(page: Page, name: string, adminUserId: string, memberIds: string[] = []) {
	const made = await page.request.post("/api/admin/teams", { data: { name, adminUserId }, headers });
	expect(made.status(), await made.text()).toBe(201);
	const { team } = await jsonOf<{ team: { id: string } }>(made);
	for (const userId of memberIds) {
		const added = await page.request.put(`/api/admin/teams/${team.id}/members/${userId}`, { data: { role: "member" }, headers });
		expect(added.ok(), await added.text()).toBe(true);
	}
	return team.id;
}

async function grant(page: Page, workspaceId: string, teamId: string, access: "ask" | "edit") {
	const response = await page.request.put(`/api/workspaces/${workspaceId}/teams/${teamId}`, { data: { access } });
	expect(response.ok(), await response.text()).toBe(true);
}

const teamRow = (scope: Locator | Page, name: string) => scope.locator('[data-slot="workspace-team"]').filter({ hasText: name });
const workspaceRows = (page: Page) => page.locator('[data-slot="workspace-rows"]');

test("Share adds a team: its members get access at once; its role changes and it is removed as a person's; an archived grant has only Remove", async ({
	page,
	admin,
	browser,
	db,
	fake,
}) => {
	test.setTimeout(90_000);
	const mark = randomBytes(3).toString("hex");
	const member = await newPerson(browser, db, fake, "team member");
	const hr = `HR ${mark}`;
	const old = `Old ${mark}`;
	await makeTeam(page, hr, admin.id, [member.person.id]);
	const oldId = await makeTeam(page, old, admin.id, [member.person.id]);
	const workspace = await createWorkspace(page, `Pay rules ${mark}`);
	await grant(page, workspace.id, oldId, "ask");
	expect((await page.request.post(`/api/admin/teams/${oldId}/archive`, { headers })).ok()).toBe(true);

	await test.step("an archived team gives nothing", async () => {
		await member.page.goto("/");
		await expect(workspaceRows(member.page)).toBeVisible();
		await expect(workspaceRows(member.page).getByRole("button", { name: `Pay rules ${mark}`, exact: true })).toHaveCount(0);
	});

	await test.step("the picker finds the team with its member count, not the archived one; Share adds it", async () => {
		await page.goto(`/?w=${workspace.slug}`);
		await page.getByRole("button", { name: "Share", exact: true }).click();
		const share = page.getByRole("dialog", { name: `Share “Pay rules ${mark}”` });
		await expect(teamRow(share, `${old} (archived)`)).toBeVisible();
		await expect(teamRow(share, old).getByRole("button", { name: `Remove ${old} (archived)` })).toBeVisible();
		await expect(teamRow(share, old).getByRole("button", { name: /^What / })).toHaveCount(0);

		await share.getByRole("combobox", { name: "Add people or teams" }).fill(mark);
		await expect(page.getByRole("option", { name: new RegExp(`${escape(hr)}.*2 members`) })).toBeVisible();
		await expect(page.getByRole("option", { name: new RegExp(escape(old)) })).toHaveCount(0);
		const saved = page.waitForResponse((response) => response.url().includes("/teams/") && response.request().method() === "PUT");
		await page.getByRole("option", { name: new RegExp(escape(hr)) }).click();
		await expect(teamRow(share, hr)).toContainText("2 members");
		await expect(teamRow(share, hr).getByRole("button", { name: /^What / })).toHaveText("Can ask");
		expect((await saved).ok()).toBe(true);

		// The archived grant is removed; the dialog keeps the active team.
		await teamRow(share, old).getByRole("button", { name: `Remove ${old} (archived)` }).click();
		await expect(teamRow(share, old)).toHaveCount(0);
		await share.getByRole("button", { name: "Done" }).click();
	});

	await test.step("the team's member sees the workspace and asks in it, but can't share", async () => {
		await member.page.reload();
		await workspaceRows(member.page).getByRole("button", { name: `Pay rules ${mark}`, exact: true }).click();
		await expect(member.page.getByRole("heading", { name: `Pay rules ${mark}`, level: 1 })).toBeVisible();
		await expect(member.page.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
	});

	await test.step("Can edit lets the member share; removing the team takes it away", async () => {
		await page.getByRole("button", { name: "Share", exact: true }).click();
		const share = page.getByRole("dialog", { name: `Share “Pay rules ${mark}”` });
		await teamRow(share, hr).getByRole("button", { name: /^What / }).click();
		await page.getByRole("menuitem", { name: /^Can edit/ }).click();
		await expect(teamRow(share, hr).getByRole("button", { name: /^What / })).toHaveText("Can edit");
		await expect.poll(async () => (await jsonOf<{ workspace: { access: string } }>(await member.page.request.get(`/api/workspaces/${workspace.id}`))).workspace.access).toBe("edit");
		await member.page.reload();
		await expect(member.page.getByRole("button", { name: "Share", exact: true })).toBeVisible();

		await teamRow(share, hr).getByRole("button", { name: /^What / }).click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		await expect(teamRow(share, hr)).toHaveCount(0);
		await expect.poll(async () => (await member.page.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(404);
	});

	await member.context.close();
});

test("a team grant on a workspace open to everyone is in the activity log, by the team's name", async ({ page, admin }) => {
	const mark = randomBytes(3).toString("hex");
	const ops = `Ops ${mark}`;
	const teamId = await makeTeam(page, ops, admin.id);
	const workspace = await createWorkspace(page, `Handbook ${mark}`);
	const opened = await page.request.put(`/api/workspaces/${workspace.id}/access`, { data: { orgAccess: "ask" } });
	expect(opened.ok()).toBe(true);
	await grant(page, workspace.id, teamId, "ask");
	await grant(page, workspace.id, teamId, "edit");

	await page.goto(`/admin/activity?person=${encodeURIComponent(admin.id)}`);
	await expect(page.getByText(`Added the team ${ops} (can ask)`)).toBeVisible();
	await expect(page.getByText(`Team ${ops}: can ask → can edit`)).toBeVisible();
});
