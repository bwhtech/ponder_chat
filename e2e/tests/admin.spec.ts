import { e2e } from "../env.ts";
import { chat, expect, jsonOf, randomIp, signIn, test, uniqueEmail, type Thread } from "../fixtures.ts";

test("an admin sees the people page", async ({ page, admin }) => {
	await page.goto("/admin/people");
	await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
	await expect(page.getByText(admin.email).first()).toBeVisible();
	await expect(page.getByText("This page is for admins")).toHaveCount(0);
});

test("an admin sets how much Auto may spend, and the next reply asks for it", async ({ page, admin, fake }) => {
	void admin;
	const tier = async () => (await jsonOf<{ autoCostTier: string }>(await page.request.get("/api/admin/settings"))).autoCostTier;
	expect(await tier()).toBe("medium");
	try {
		await page.goto("/admin/settings");
		const select = page.getByRole("dialog").getByLabel("Auto cost level");
		await select.click();
		await page.getByRole("option", { name: "High" }).click();
		await expect(page.getByText("Auto cost level saved")).toBeVisible();
		expect(await tier()).toBe("high");

		await page.goto("/");
		await chat.send(page, "Spend more, tier test");
		await chat.idle(page);
		const [call] = await fake.calls("tier test");
		expect(call.plugins).toContainEqual(expect.objectContaining({ id: "auto-router", cost_tier: "high" }));

		await page.goto("/admin/activity");
		await expect(page.getByText("Changed what Auto may spend").first()).toBeVisible();
		await expect(page.getByText("Medium → High").first()).toBeVisible();
	} finally {
		await page.request.put("/api/admin/settings/auto-cost-tier", { data: { tier: "medium" }, headers: { Origin: e2e.baseUrl } });
	}
});

test("a person without the admin role can't open the admin pages", async ({ page, person }) => {
	await page.goto("/admin");
	await expect(page.getByRole("heading", { name: "This page is for admins" })).toBeVisible();
	await expect(page.getByText(person.email)).toBeVisible();

	const response = await page.request.get("/api/admin/people");
	expect(response.status()).toBe(403);
});

test("one person can't read another's chat", async ({ page, person, fake, db, browser }) => {
	void person;
	await page.goto("/");
	await chat.send(page, "A private chat");
	await chat.idle(page);
	const id = new URL(page.url()).searchParams.get("t")!;
	// The page goes idle when the stream ends; the reply is saved a moment later.
	await expect.poll(async () => (await jsonOf<Thread>(await page.request.get(`/api/threads/${id}`))).messages.length).toBe(2);

	// Signed out: refused.
	const stranger = await browser.newContext({ baseURL: e2e.baseUrl });
	expect((await stranger.request.get(`/api/threads/${id}`)).status()).toBe(401);
	await stranger.close();

	// Signed in as someone else: an empty chat, as for an id never used, and no reply stream to follow.
	const other = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	await signIn(await other.newPage(), db, fake, uniqueEmail("other person"));
	expect(await (await other.request.get(`/api/threads/${id}`)).json()).toEqual({ messages: [], running: false });
	expect((await other.request.get(`/api/chat/${id}/stream`)).status()).toBe(204);
	await other.close();
});
