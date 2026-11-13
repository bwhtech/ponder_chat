import { e2e } from "../env.ts";
import { chat, expect, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";

test("an admin sees the people page", async ({ page, admin }) => {
	await page.goto("/admin/people");
	await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
	await expect(page.getByText(admin.email).first()).toBeVisible();
	await expect(page.getByText("This page is for admins")).toHaveCount(0);
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
	await expect.poll(async () => (await (await page.request.get(`/api/threads/${id}`)).json()).messages.length).toBe(2);

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
