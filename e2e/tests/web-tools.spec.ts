import type { Page } from "@playwright/test";
import { chat, expect, test } from "../fixtures.ts";
import { createWorkspace, textFile, uploadReady, workspacePage } from "../workspaces.ts";

/**
 * Web and Research under the message box (web/web-tools.ts): what the model is given, and
 * told, for each choice, and what the page shows of it.
 */
/** The message box's Web menu: its button names where the answer comes from. */
const webMenu = (page: Page) => page.locator('[data-web-menu]').last();
async function pick(page: Page, row: string) {
	await webMenu(page).click();
	await page.getByRole("menuitem", { name: new RegExp(`^${row.replace("+", "\\+")}`) }).click();
}
const replyWeb = (page: Page) => chat.reply(page).locator('[data-slot="reply-web"]');
const offer = (page: Page) => page.getByRole("button", { name: "Search the web for this" });

test("a chat searches the web until Web is turned off; then the model has no web tool, and the chat stays off after a reload", async ({ page, person, fake }) => {
	const tag = person.id.slice(0, 6);
	await page.goto("/");
	await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: Web");

	await chat.send(page, `With the web ${tag}`);
	await chat.idle(page);
	const [withWeb] = await fake.calls(`With the web ${tag}`);
	expect(withWeb.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
	expect(withWeb.system).toContain("You can search the web with web_search");
	// The usual chat says nothing under its reply.
	await expect(replyWeb(page)).toHaveCount(0);

	await pick(page, "No web");
	await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: No web");
	await chat.send(page, `Without the web ${tag}`);
	await chat.idle(page);
	const [without] = await fake.calls(`Without the web ${tag}`);
	expect(without.tools).not.toContain("web_search");
	expect(without.tools).not.toContain("web_fetch");
	expect(without.tools).not.toContain("offer_web_search");
	expect(without.system).toContain("Web search is off in this chat");
	expect(without.system).not.toContain("You can search the web with web_search");
	await expect(replyWeb(page)).toHaveText("Web search off");

	await page.reload();
	await expect(chat.reply(page)).toContainText(`Without the web ${tag}`);
	await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: No web");
	await expect(replyWeb(page)).toHaveText("Web search off");
});

test("a workspace chat answers from Sources only; when they fall short it says so and offers the web, which searches for that question once", async ({ page, person, fake }) => {
	const tag = person.id.slice(0, 6);
	const name = `Food drive ${tag}`;
	const question = `Does the city need a permit ${tag}?`;
	const url = "https://city.example.com/permits";
	const { id, slug } = await createWorkspace(page, name);
	await uploadReady(page, id, textFile("Street events.md", "# Street events\n\nSet up tables by 8:30."));
	await fake.chat({
		match: question,
		steps: [{ toolCalls: [{ name: "offer_web_search", input: { missing: "city permits" } }] }, { text: "Sources don't cover city permits." }],
	});

	await page.goto(`/?w=${slug}`);
	await expect(page.locator('[data-slot="workspace-composer"] [data-web-menu]')).toHaveAttribute("aria-label", "Answer from: Sources only");
	await workspacePage.field(page).fill(question);
	await workspacePage.field(page).press("Enter");
	await expect(chat.reply(page)).toContainText("Sources don't cover city permits.");
	await chat.idle(page);

	await test.step("The model had the workspace's rules for Sources only, and no web tool", async () => {
		const [first] = await fake.calls(question);
		expect(first.tools).toContain("offer_web_search");
		expect(first.tools).not.toContain("web_search");
		expect(first.tools).not.toContain("web_fetch");
		expect(first.system).toContain("Answer only from the workspace");
		expect(first.system).toContain("Web search is off in this chat");
		expect(first.system).not.toContain("answer from what you know or from the web");
	});

	await test.step("The reply says what is missing, names what it used, and offers the web", async () => {
		await expect(chat.reply(page)).toContainText("Not in Sources · city permits");
		await expect(replyWeb(page)).toHaveText("Sources only");
		await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: Sources only");
		await expect(offer(page)).toBeVisible();
	});

	await test.step("Search the web for this: the same question, answered from the web, and the chat stays on Sources", async () => {
		await fake.search({ match: "street permit", results: [{ url, title: "Permits", content: "A street event needs a permit." }] });
		await fake.chat({
			match: question,
			steps: [{ toolCalls: [{ name: "web_search", input: { query: "street permit" } }] }, { text: `The city needs a permit ([City](${url})).` }],
		});
		const before = (await fake.calls(question)).length;
		await offer(page).click();
		await expect(chat.reply(page)).toContainText("The city needs a permit");
		await chat.idle(page);
		const calls = (await fake.calls(question)).slice(before);
		expect(calls[0].tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
		expect(calls[0].tools).not.toContain("offer_web_search");
		expect(calls[0].system).toContain("Answer from the workspace first");
		// One question and one reply: the web answer took the first reply's place.
		await expect(page.locator('[data-slot="message"][data-role="user"]')).toHaveCount(1);
		await expect(chat.messages(page)).toHaveCount(2);
		await expect(replyWeb(page)).toHaveText("Sources + web");
		await expect(offer(page)).toHaveCount(0);
		await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: Sources only");
	});

	await test.step("After a reload the chat is still on Sources only, and the next question has no web tool", async () => {
		await page.reload();
		await expect(chat.reply(page)).toContainText("The city needs a permit");
		await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: Sources only");
		await chat.send(page, `And for tables ${tag}?`);
		await chat.idle(page);
		const [next] = await fake.calls(`And for tables ${tag}?`);
		expect(next.tools).not.toContain("web_search");
		expect(next.tools).toContain("offer_web_search");
	});
});

test("Research is for one message: its searches are deep, the reply says so, and the chat goes back to how it was", async ({ page, person, fake }) => {
	const tag = person.id.slice(0, 6);
	const question = `Why do volunteers leave ${tag}?`;
	const query = `volunteer retention ${tag}`;
	await fake.chat({ match: question, steps: [{ toolCalls: [{ name: "web_search", input: { query } }] }, { text: "Most leave in the first three months." }] });
	await page.goto("/");
	await pick(page, "No web");
	await pick(page, "Deep research");
	await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: Deep research");
	await expect(webMenu(page)).toHaveAttribute("data-research", "true");
	await expect(chat.field(page)).toHaveAttribute("placeholder", "Ask a research question");

	await chat.send(page, question);
	await expect(chat.reply(page)).toContainText("Most leave in the first three months.");
	await chat.idle(page);
	const [first] = await fake.calls(question);
	expect(first.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
	expect(first.system).toContain("The person asked for deep research on this message");
	expect(await fake.searches(query)).toMatchObject([{ mode: "deep", maxResults: 10 }]);
	await expect(chat.reply(page)).toContainText(`Researched “${query}”`);
	await expect(replyWeb(page)).toHaveText("Deep research");

	// Research went off with the message, and Web is off as it was before.
	await expect(webMenu(page)).toHaveAttribute("aria-label", "Answer from: No web");
	await expect(webMenu(page)).not.toHaveAttribute("data-research");
	await chat.send(page, `And then ${tag}?`);
	await chat.idle(page);
	const [next] = await fake.calls(`And then ${tag}?`);
	expect(next.tools).not.toContain("web_search");
	expect(next.system).not.toContain("deep research");
});

test("a quick search asks for no depth", async ({ page, person, fake }) => {
	const tag = person.id.slice(0, 6);
	const query = `vue release ${tag}`;
	await fake.chat({ match: `Which Vue ${tag}`, steps: [{ toolCalls: [{ name: "web_search", input: { query } }] }, { text: "Vue 9." }] });
	await page.goto("/");
	await chat.send(page, `Which Vue ${tag}?`);
	await expect(chat.reply(page)).toContainText("Vue 9.");
	const [search] = await fake.searches(query);
	expect(search.mode).toBeUndefined();
	expect(search.maxResults).toBe(6);
	await expect(chat.reply(page)).toContainText(`Searched “${query}”`);
});
