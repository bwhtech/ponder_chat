/**
 * Team invites through their routes (routes.ts): an email with an account joins at once,
 * a new email is invited (team_invites and allowed_emails), and an invite can be cancelled
 * without leaving a way in. Emails go to a stand-in for Cloudflare's API, which fails
 * for addresses that start with "fail": a failed email changes nothing.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import type { Email } from "../email/Mailer.ts";
import { parseJson } from "../test-json.ts";
// Types only: the module itself is imported below, once the environment is set.
import type { One, Refusal } from "./test-app.ts";

/** What the stand-in received. */
const sent: Email[] = [];
const mail = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk: Buffer) => (body += chunk.toString()));
	request.on("end", () => {
		const email = parseJson<Email>(body);
		sent.push(email);
		response.writeHead(email.to.startsWith("fail") ? 500 : 200, { "content-type": "application/json" }).end("{}");
	});
});
await new Promise<void>((resolve) => mail.listen(0, "127.0.0.1", resolve));
Object.assign(process.env, {
	PONDER_EMAIL_FROM: "ponder@example.invalid",
	CLOUDFLARE_ACCOUNT_ID: "test",
	CLOUDFLARE_EMAIL_TOKEN: "test",
	CLOUDFLARE_API_URL: `http://127.0.0.1:${(mail.address() as AddressInfo).port}`,
});

const { base, call, create, database, emailOf, holdEvents, joinTeams, setMember, setUp, tag, tearDown, who } = await import("./test-app.ts");

type Invited = One & Refusal & { invited?: true; added?: true };
const invite = (by: "boss" | "ana" | "cy", teamId: string, email: string, role: "member" | "admin" = "member") =>
	call<Invited>(by, "POST", `/api/admin/teams/${teamId}/invites`, { email, role });
const cancel = (by: "boss" | "ana" | "cy", teamId: string, email: string) => call<One & Refusal>(by, "DELETE", `/api/admin/teams/${teamId}/invites/${encodeURIComponent(email)}`);
const newEmail = (name: string) => `${name}-${tag}@new.invalid`;
const allowed = (email: string) =>
	database((sql) => sql<{ team_only: boolean; invited_by: string | null; daily_credits: number | null }>`select team_only, invited_by, daily_credits from allowed_emails where email = ${email}`);
const invitesOf = async (email: string) =>
	(await database((sql) => sql<{ team_id: string }>`select team_id from team_invites where email = ${email}`)).map((row) => row.team_id);
const mailTo = (email: string) => sent.filter((each) => each.to === email);
describe.skipIf(!base)("team invites", () => {
	beforeAll(setUp);
	afterAll(async () => {
		await tearDown();
		mail.close();
	});

	it("invites a new email: a pending invite with its role, and a way in with the default credits", async () => {
		const team = (await create("boss", "Hiring", "ana")).body.team.id;
		const email = newEmail("nia");
		const answer = await invite("ana", team, `  ${email.toUpperCase()} `, "admin");
		assert.strictEqual(answer.status, 200, JSON.stringify(answer.body));
		assert.isTrue(answer.body.invited);
		assert.deepStrictEqual(
			answer.body.team.invites.map((each) => [each.email, each.role, each.invitedBy]),
			[[email, "admin", "ana"]],
		);
		assert.deepStrictEqual(await allowed(email), [{ team_only: true, invited_by: who.ana, daily_credits: null }]);

		const [email1] = mailTo(email);
		assert.strictEqual(email1?.subject, "You are invited to Ponder Chat");
		assert.include(email1?.text, "ana invited you to the team “Hiring”. You join it when you first sign in.");
	});

	it("adds an email that has an account at once, with the role picked, and tells them", async () => {
		const team = (await create("boss", "Payroll", "ana")).body.team.id;
		const answer = await invite("ana", team, emailOf("bob").toUpperCase(), "admin");
		assert.strictEqual(answer.status, 200, JSON.stringify(answer.body));
		assert.isTrue(answer.body.added);
		assert.deepInclude(answer.body.team.members.find((each) => each.id === who.bob), { role: "admin" });
		assert.deepStrictEqual(answer.body.team.invites, []);
		const [told] = mailTo(emailOf("bob")).filter((each) => each.text.includes("Payroll"));
		assert.strictEqual(told?.subject, "You were added to Payroll");
		assert.include(told?.text, "You were added to Payroll as a team admin by ana.");

		// Again with another role: a role change, with no email.
		const before = mailTo(emailOf("bob")).length;
		assert.isTrue((await invite("ana", team, emailOf("bob"), "member")).body.added);
		assert.strictEqual(mailTo(emailOf("bob")).length, before);
	});

	it("refuses a banned person, a bad email, and a team admin's change that leaves no team admin", async () => {
		const team = (await create("boss", "Records", "ana")).body.team.id;
		const banned = await invite("ana", team, emailOf("eve"));
		assert.deepStrictEqual([banned.status, banned.body.error], [403, "This person is banned, so they can't join a team."]);
		assert.strictEqual((await invite("ana", team, "not an email")).status, 400);
		const self = await invite("ana", team, emailOf("ana"), "member");
		assert.deepStrictEqual([self.status, self.body.error], [403, "A team needs at least one team admin. Make someone else a team admin first."]);
	});

	it("changes the role of an invite sent before, and emails only the first time", async () => {
		const team = (await create("boss", "Legal ops", "ana")).body.team.id;
		const email = newEmail("ola");
		await invite("ana", team, email, "member");
		const again = await invite("ana", team, email, "admin");
		assert.deepStrictEqual(again.body.team.invites.map((each) => [each.email, each.role]), [[email, "admin"]]);
		assert.strictEqual(mailTo(email).length, 1);
	});

	it("keeps the change when the email fails", async () => {
		const team = (await create("boss", "Unlucky", "ana")).body.team.id;
		const email = newEmail("fail-pat");
		const answer = await invite("ana", team, email);
		assert.strictEqual(answer.status, 200);
		assert.deepStrictEqual(answer.body.team.invites.map((each) => each.email), [email]);
		assert.strictEqual(mailTo(email).length, 1, "it was tried");
	});

	it("cancels an invite, and takes the email out of allowed_emails when nothing else holds it", async () => {
		const [first, second] = [(await create("boss", "First", "ana")).body.team.id, (await create("boss", "Second", "cy")).body.team.id];
		const email = newEmail("quin");
		await invite("ana", first, email);
		await invite("cy", second, email);

		const cancelled = await cancel("ana", first, email);
		assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
		assert.deepStrictEqual(cancelled.body.team.invites, []);
		assert.lengthOf(await allowed(email), 1, "the other team's invite still holds it");

		assert.strictEqual((await cancel("ana", second, email)).status, 403, "another team's invite");
		assert.strictEqual((await cancel("boss", second, email)).status, 200, "an org admin");
		assert.lengthOf(await allowed(email), 0, "no way in is left");
		assert.strictEqual((await cancel("boss", second, email)).status, 200, "no such invite: no change");
	});

	it("keeps an email that an org admin invited directly, before or after the team", async () => {
		const team = (await create("boss", "Direct", "ana")).body.team.id;
		const [before, after] = [newEmail("ray"), newEmail("sol")];
		assert.strictEqual((await call("boss", "POST", "/api/admin/invites", { emails: [before] })).status, 200);
		await invite("ana", team, before);
		assert.deepInclude((await allowed(before))[0], { team_only: false, invited_by: who.boss });

		await invite("ana", team, after);
		const direct = await call<{ invited: number }>("boss", "POST", "/api/admin/invites", { emails: [after], dailyCredits: 500 });
		assert.strictEqual(direct.status, 200, "a team-only invite is not taken");
		assert.deepStrictEqual(await allowed(after), [{ team_only: false, invited_by: who.boss, daily_credits: 500 }]);

		await cancel("ana", team, before);
		await cancel("ana", team, after);
		assert.lengthOf(await allowed(before), 1);
		assert.lengthOf(await allowed(after), 1);
	});

	it("logs each invite and each cancelled invite, with the email", async () => {
		const team = (await create("boss", "Audited", "ana")).body.team.id;
		const email = newEmail("tam");
		await invite("ana", team, email, "admin");
		await cancel("ana", team, email);
		const logged = await database(
			(sql) => sql<{ action: string; target: string | null; before: unknown; after: unknown }>`
				select action, target, before, after from admin_events where coalesce(after, before)->>'team' = ${team} and action <> 'create-team' order by id`,
		);
		assert.deepStrictEqual(logged, [
			{ action: "invite-to-team", target: email, before: null, after: { team, name: "Audited", role: "admin" } },
			{ action: "cancel-team-invite", target: email, before: { team, name: "Audited", role: "admin" }, after: null },
		]);
	});

	it("makes the person a member of each team that invited them, at their first sign-in, and logs each", async () => {
		const [one, two] = [(await create("boss", "Join one", "ana")).body.team.id, (await create("boss", "Join two", "ana")).body.team.id];
		const email = newEmail("uma");
		await invite("ana", one, email, "admin");
		await invite("ana", two, email, "member");
		const id = `uma-${tag}`;
		await database((sql) => sql`insert into users (id, name, email, role) values (${id}, '', ${email.toUpperCase()}, 'user')`);
		// What Auth.ts runs once it has made the account.
		await joinTeams({ id, email: email.toUpperCase() });

		const team = (await call<One>("ana", "GET", `/api/admin/teams/${one}`)).body.team;
		assert.deepInclude(team.members.find((each) => each.id === id), { role: "admin", email: email.toUpperCase() });
		assert.deepStrictEqual(team.invites, []);
		assert.deepInclude((await call<One>("ana", "GET", `/api/admin/teams/${two}`)).body.team.members.find((each) => each.id === id), { role: "member" });
		assert.lengthOf(await allowed(email), 1, "the way in stays: it is their account's now");

		const logged = await database(
			(sql) => sql<{ actor_id: string; action: string; target: string; after: unknown }>`select actor_id, action, target, after from admin_events where target = ${id} order by id`,
		);
		assert.deepStrictEqual(logged, [
			{ actor_id: id, action: "add-team-member", target: id, after: { team: one, name: "Join one", role: "admin", byInvite: true } },
			{ actor_id: id, action: "add-team-member", target: id, after: { team: two, name: "Join two", role: "member", byInvite: true } },
		]);
	});

	it("cancels an email's team invites when an org admin removes it on People, and logs each", async () => {
		const [first, second] = [(await create("boss", "Removed one", "ana")).body.team.id, (await create("boss", "Removed two", "cy")).body.team.id];
		const email = newEmail("yan");
		await invite("ana", first, email, "admin");
		await invite("cy", second, email);
		assert.strictEqual((await call("boss", "DELETE", `/api/admin/invites/${encodeURIComponent(email)}`)).status, 200);

		assert.deepStrictEqual((await call<One>("ana", "GET", `/api/admin/teams/${first}`)).body.team.invites, []);
		assert.deepStrictEqual((await call<One>("cy", "GET", `/api/admin/teams/${second}`)).body.team.invites, []);
		assert.lengthOf(await allowed(email), 0);
		const logged = await database(
			(sql) => sql<{ actor_id: string; before: unknown }>`
				select actor_id, before from admin_events where target = ${email} and action = 'cancel-team-invite' order by before->>'name'`,
		);
		assert.deepStrictEqual(logged, [
			{ actor_id: who.boss, before: { team: first, name: "Removed one", role: "admin" } },
			{ actor_id: who.boss, before: { team: second, name: "Removed two", role: "member" } },
		]);
	});

	it("puts the way in back when an email is invited again with the same role", async () => {
		const team = (await create("boss", "Repaired", "ana")).body.team.id;
		const email = newEmail("zed");
		await invite("ana", team, email);
		// What a removal on People left before it cancelled the team invites too.
		await database((sql) => sql`delete from allowed_emails where email = ${email}`);
		assert.strictEqual((await invite("ana", team, email)).status, 200);
		assert.deepStrictEqual(await allowed(email), [{ team_only: true, invited_by: who.ana, daily_credits: null }]);
	});

	it("joins the team of an invite that commits while the account is made", async () => {
		const team = (await create("boss", "Late invite", "ana")).body.team.id;
		const email = newEmail("wes");
		const events = await holdEvents();
		// The invite found no account, wrote its rows, and waits to commit.
		const invited = invite("ana", team, email, "admin");
		await events.waiting([invited]);
		const id = `wes-${tag}`;
		await database((sql) => sql`insert into users (id, name, email, role) values (${id}, '', ${email}, 'user')`);
		const joined = joinTeams({ id, email });
		await events.waiting([invited, joined]);
		await events.release();
		await Promise.all([invited, joined]);

		const after = (await call<One>("ana", "GET", `/api/admin/teams/${team}`)).body.team;
		assert.deepInclude(after.members.find((each) => each.id === id), { role: "admin" });
		assert.deepStrictEqual(after.invites, []);
	});

	it("keeps the way in of an invite that commits while another team cancels its own", async () => {
		const [first, second] = [(await create("boss", "Race first", "ana")).body.team.id, (await create("boss", "Race second", "cy")).body.team.id];
		const email = newEmail("abe");
		await invite("ana", first, email);
		const events = await holdEvents();
		const invited = invite("cy", second, email);
		await events.waiting([invited]);
		const cancelled = cancel("ana", first, email);
		await events.waiting([invited, cancelled]);
		await events.release();
		assert.deepStrictEqual((await Promise.all([invited, cancelled])).map((each) => each.status), [200, 200]);

		assert.deepStrictEqual(await invitesOf(email), [second]);
		assert.lengthOf(await allowed(email), 1);
	});

	it("cancels an invite that commits while an org admin removes its email", async () => {
		const [first, second] = [(await create("boss", "Removal first", "ana")).body.team.id, (await create("boss", "Removal second", "cy")).body.team.id];
		const email = newEmail("bea");
		await invite("ana", first, email);
		const events = await holdEvents();
		const invited = invite("cy", second, email);
		await events.waiting([invited]);
		const removed = call("boss", "DELETE", `/api/admin/invites/${encodeURIComponent(email)}`);
		await events.waiting([invited, removed]);
		await events.release();
		assert.deepStrictEqual((await Promise.all([invited, removed])).map((each) => each.status), [200, 200]);

		assert.deepStrictEqual(await invitesOf(email), []);
		assert.lengthOf(await allowed(email), 0);
	});

	it("lets a team admin of another team add nobody to this one", async () => {
		const team = (await create("boss", "Closed", "ana")).body.team.id;
		await setMember("boss", team, "dan", "member");
		const answer = await invite("cy", team, newEmail("vic"));
		assert.deepStrictEqual([answer.status, answer.body.error], [403, "Only this team's admins and org admins can do this."]);
	});
});

