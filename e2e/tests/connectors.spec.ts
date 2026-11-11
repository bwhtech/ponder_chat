import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import type { McpCall } from "../mcp/calls.ts";
import { SHOP_KEY } from "../mcp/server.ts";
import { chat, expect, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";

/**
 * Connectors (Settings, Connectors) against the test MCP servers in e2e/mcp/server.ts:
 * adding one with no sign-in, with an API key and with OAuth, and the model using its
 * tools, with and without the person's approval. Each server's tools are find_order,
 * which only reads, and add_note.
 */
const OPEN = `${e2e.mcpUrl}/open/mcp`;
const KEY = `${e2e.mcpUrl}/key/mcp`;
const OAUTH = `${e2e.mcpOAuthUrl}/mcp`;

/** An order number no other test uses: the servers are shared, and their calls are found by it. */
const orderNumber = () => `A${randomBytes(3).toString("hex")}`;

/** The tool calls that the test servers ran with this order. */
async function serverCalls(page: Page, order: string): Promise<McpCall[]> {
	return (await page.request.get(`${e2e.mcpUrl}/__mcp/calls?match=${order}`)).json();
}

/** Adds the open server as "Shop" through the API, for tests about using it. */
async function addShop(page: Page) {
	const response = await page.request.post("/api/connectors", { data: { name: "Shop", url: OPEN, transport: "http", auth: "none" } });
	expect(response.ok(), await response.text()).toBe(true);
}

async function openAddConnector(page: Page) {
	await page.goto("/?settings=connectors");
	await page.getByRole("button", { name: "Add connector" }).click();
	return page.getByRole("dialog");
}

test.beforeEach(async ({ person }) => {
	void person;
});

test("adds a server that needs no sign-in", async ({ page }) => {
	const dialog = await openAddConnector(page);
	await dialog.getByLabel("Server URL").fill(OPEN);
	await expect(dialog.getByText("No sign-in needed.")).toBeVisible();
	// The name is the one the server gives itself.
	await expect(dialog.getByLabel("Name")).toHaveValue("Test Shop");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();

	await expect(dialog.getByText("Test Shop is connected")).toBeVisible();
	await expect(dialog.getByText("2 tools. Ponder uses the 1 that only read, and asks you before it uses the other 1.")).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(page.getByRole("button", { name: "Open Test Shop" })).toBeVisible();
});

test("adds a server that needs an API key, and refuses a wrong key", async ({ page }) => {
	const dialog = await openAddConnector(page);
	await dialog.getByLabel("Server URL").fill(KEY);
	await expect(dialog.getByText("This server needs an API key.")).toBeVisible();
	// A server that wants a key gives no name before it has one.
	await dialog.getByLabel("Name").fill("Shop");
	const value = dialog.getByLabel("Value of Authorization");

	await value.fill("Bearer wrong-key");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("The server refused the sign-in or the key.");
	await expect(dialog.getByText("Shop is connected")).toHaveCount(0);

	await value.fill(`Bearer ${SHOP_KEY}`);
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog.getByText("Shop is connected")).toBeVisible();
});

test("signs in to a server with OAuth, then uses its tools", async ({ page, fake }) => {
	const dialog = await openAddConnector(page);
	await dialog.getByLabel("Server URL").fill(OAUTH);
	await expect(dialog.getByText("Uses sign-in.")).toBeVisible();
	await dialog.getByLabel("Name").fill("Shop");
	// The sign-in opens in a new window. The test server's sign-in says yes at once, and the window closes.
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog.getByText("Shop is connected")).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();

	// The token from the sign-in works for a tool call.
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [{ name: "shop__find_order", input: { order } }] }, { text: "It shipped." }] });
	await page.goto("/");
	await chat.send(page, `Where is order ${order}?`);
	await expect(chat.reply(page)).toContainText("It shipped.");
	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ server: "oauth", tool: "find_order", args: { order } })]);
});

test("uses a tool that only reads without asking", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [{ name: "shop__find_order", input: { order } }] }, { text: "Your order shipped on 3 November." }] });

	await page.goto("/");
	await chat.send(page, `Where is order ${order}?`);
	await expect(chat.reply(page)).toContainText("Your order shipped on 3 November.");
	await expect(chat.reply(page).getByText("Shop · Find order")).toBeVisible();

	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ server: "open", tool: "find_order", args: { order } })]);
	const calls = await fake.calls(order);
	expect(calls[0].tools).toEqual(expect.arrayContaining(["shop__find_order", "shop__add_note"]));
	// The model's second call got what the server returned.
	expect(JSON.stringify(calls[1].messages)).toContain("2 blue mugs");
});

test("asks before a tool that changes something, and runs it once allowed", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({
		match: order,
		steps: [{ toolCalls: [{ name: "shop__add_note", input: { order, note: "Gift wrap" } }] }, { text: "I added the note." }],
	});

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	expect(await serverCalls(page, order)).toEqual([]);

	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(chat.reply(page)).toContainText("I added the note.");
	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ tool: "add_note", args: { order, note: "Gift wrap" } })]);
});

test("does not run a tool that the person denies", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({
		match: order,
		steps: [{ toolCalls: [{ name: "shop__add_note", input: { order, note: "Rush" } }] }, { text: "OK, I left the order as it was." }],
	});

	await page.goto("/");
	await chat.send(page, `Add a rush note to order ${order}`);
	await page.getByRole("button", { name: "Deny" }).click();
	await expect(chat.reply(page)).toContainText("OK, I left the order as it was.");
	expect(await serverCalls(page, order)).toEqual([]);
	expect(JSON.stringify((await fake.calls(order))[1].messages)).toContain("The person denied this.");
});

test("stops asking for a tool that the person always allows", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	const steps = [{ toolCalls: [{ name: "shop__add_note", input: { order, note: "Fragile" } }] }, { text: "Noted." }];
	await fake.chat({ match: order, steps });

	await page.goto("/");
	await chat.send(page, `Mark order ${order} as fragile`);
	await page.getByRole("button", { name: "Always allow" }).click();
	await expect(chat.reply(page)).toContainText("Noted.");

	await chat.send(page, `Mark order ${order} as fragile again`);
	await expect(chat.reply(page)).toContainText("Noted.");
	await expect(page.getByRole("button", { name: "Always allow" })).toHaveCount(0);
	expect(await serverCalls(page, order)).toHaveLength(2);
});

test("does not give one person's connectors to another", async ({ page, browser, db, fake }) => {
	await addShop(page);

	const other = await browser.newContext({ baseURL: e2e.baseUrl, extraHTTPHeaders: { "cf-connecting-ip": randomIp() } });
	const otherPage = await other.newPage();
	await signIn(otherPage, db, fake, uniqueEmail("other person"));
	const message = `Which tools, ${orderNumber()}?`;
	await otherPage.goto("/");
	await chat.send(otherPage, message);
	await chat.idle(otherPage);

	const [call] = await fake.calls(message);
	expect(call.tools).toContain("web_search");
	expect(call.tools.filter((name) => name.startsWith("shop__"))).toEqual([]);
	expect(await (await otherPage.request.get("/api/connectors")).json()).toEqual({ connectors: [] });
	await other.close();
});
