import type { Browser } from "@playwright/test";
import type postgres from "postgres";
import { e2e } from "../env.ts";
import { expect, randomIp, signIn, test, uniqueEmail, type Fake } from "../fixtures.ts";

/** Another person with an account, signed in from their own browser. */
async function otherPerson(browser: Browser, db: postgres.Sql, fake: Fake, title: string) {
	const context = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	const person = await signIn(await context.newPage(), db, fake, uniqueEmail(title));
	await context.close();
	return person;
}

test("an email change through Better Auth is logged, and the old address is told", async ({ page, admin, browser, db, fake }) => {
	const person = await otherPerson(browser, db, fake, "email change");
	const newEmail = uniqueEmail("new address");
	const headers = { origin: e2e.baseUrl };

	const changed = await page.request.post("/api/auth/admin/update-user", { data: { userId: person.id, data: { email: newEmail } }, headers });
	expect(changed.ok(), await changed.text()).toBe(true);

	const events = await db<{ actor_id: string; actor_email: string; before: { email: string }; after: { email: string } }[]>`
		select actor_id, actor_email, before, after from admin_events where action = 'update-user' and target = ${person.id}`;
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ actor_id: admin.id, actor_email: admin.email, before: { email: person.email }, after: { email: newEmail } });

	const notice = await fake.email(person.email);
	expect(notice.subject).toBe("The email of your Ponder Chat account changed");
	expect(notice.text).toContain(newEmail);
	expect(notice.text).toContain(admin.email);

	// A refused change is not logged: the admin's own email belongs to someone else.
	const refused = await page.request.post("/api/auth/admin/update-user", { data: { userId: person.id, data: { email: admin.email } }, headers });
	expect(refused.ok()).toBe(false);
	const [{ count }] = await db<{ count: number }[]>`select count(*)::int as count from admin_events where target = ${person.id}`;
	expect(count).toBe(1);

	await page.goto(`/admin/activity?person=${encodeURIComponent(person.id)}`);
	await expect(page.getByText("Changed the email").first()).toBeVisible();
	await expect(page.getByText(`${person.email} → ${newEmail}`).first()).toBeVisible();
});

// Better Auth reads userId with z.coerce.string(), so ["<id>"] names the same person, and must be logged as that person.
test("an email change with the user id in an array is logged, and the old address is told", async ({ page, admin, browser, db, fake }) => {
	const person = await otherPerson(browser, db, fake, "array id");
	const newEmail = uniqueEmail("array new address");
	const headers = { origin: e2e.baseUrl };

	const changed = await page.request.post("/api/auth/admin/update-user", { data: { userId: [person.id], data: { email: newEmail } }, headers });
	expect(changed.ok(), await changed.text()).toBe(true);

	const events = await db<{ actor_id: string; target: string; before: { email: string }; after: { email: string } }[]>`
		select actor_id, target, before, after from admin_events where action = 'update-user' and actor_id = ${admin.id}`;
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ target: person.id, before: { email: person.email }, after: { email: newEmail } });
	expect((await fake.email(person.email)).text).toContain(newEmail);

	// A role set to what it was keeps the role, so the page can say there was no change.
	const role = await page.request.post("/api/auth/admin/set-role", { data: { userId: [person.id], role: "user" }, headers });
	expect(role.ok(), await role.text()).toBe(true);
	const [setRole] = await db<{ target: string; before: unknown; after: unknown }[]>`
		select target, before, after from admin_events where action = 'set-role' and actor_id = ${admin.id}`;
	expect(setRole).toEqual({ target: person.id, before: { role: "user" }, after: { role: "user" } });
	await page.goto(`/admin/activity?person=${encodeURIComponent(person.id)}`);
	await expect(page.getByText("Set the role to user, no change")).toBeVisible();
});

test("a change made on /admin is logged once", async ({ page, admin, browser, db, fake }) => {
	const person = await otherPerson(browser, db, fake, "role change");

	// Through /api/admin, which calls Better Auth: logged in Better Auth's hook only.
	const role = await page.request.put(`/api/admin/people/${person.id}/role`, { data: { role: "admin" } });
	expect(role.ok(), await role.text()).toBe(true);
	// Ponder's own route.
	const grant = await page.request.post(`/api/admin/people/${person.id}/grant`, { data: { credits: 25 } });
	expect(grant.ok(), await grant.text()).toBe(true);

	const events = await db<{ action: string; actor_id: string; after: Record<string, unknown> }[]>`
		select action, actor_id, after from admin_events where target = ${person.id} order by id`;
	expect(events.map((event) => event.action)).toEqual(["set-role", "grant-credits"]);
	expect(events.every((event) => event.actor_id === admin.id)).toBe(true);
	expect(events[0].after).toEqual({ role: "admin" });
	expect(events[1].after).toEqual({ credits: 25 });

	const { events: listed } = await (await page.request.get(`/api/admin/activity?person=${encodeURIComponent(person.id)}`)).json();
	expect(listed.map((event: { action: string }) => event.action)).toEqual(["grant-credits", "set-role"]);
});
