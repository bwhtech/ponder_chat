import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import type { McpCall } from "../mcp/calls.ts";
import { SHOP_KEY } from "../mcp/server.ts";
import { chat, expect, randomIp, signIn, test, uniqueEmail } from "../fixtures.ts";

/**
 * Connectors (Settings, Connectors) against the test MCP servers in e2e/mcp/server.ts:
 * adding one with no sign-in, with an API key and with OAuth, and the model finding and
 * using its tools through connector_search and connector_call, with and without the
 * person's approval. Each server's tools are find_order, which only reads, and add_note.
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

/** A model's call to a connector tool, through connector_call. */
const call = (tool: string, input: Record<string, unknown>) => ({ name: "connector_call", input: { tool, input } });

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
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__find_order", { order })] }, { text: "It shipped." }] });
	await page.goto("/");
	await chat.send(page, `Where is order ${order}?`);
	await expect(chat.reply(page)).toContainText("It shipped.");
	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ server: "oauth", tool: "find_order", args: { order } })]);
});

test("uses a tool that only reads without asking", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__find_order", { order })] }, { text: "Your order shipped on 3 November." }] });

	await page.goto("/");
	await chat.send(page, `Where is order ${order}?`);
	await expect(chat.reply(page)).toContainText("Your order shipped on 3 November.");
	// The step is named after the tool that connector_call ran.
	await expect(chat.reply(page).getByText("Shop · Find order")).toBeVisible();

	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ server: "open", tool: "find_order", args: { order } })]);
	const calls = await fake.calls(order);
	// Connector tools are not tools of their own: the model finds and calls them through two tools.
	expect(calls[0].tools).toEqual(expect.arrayContaining(["connector_search", "connector_call"]));
	expect(calls[0].tools.filter((name) => name.includes("__"))).toEqual([]);
	// The note with the person's message names the connector and, with few tools, each tool's signature.
	const sent = JSON.stringify(calls[0].messages);
	expect(sent).toContain("<connectors>");
	expect(sent).toContain("shop__find_order({ order: string })");
	expect(calls[0].system).not.toContain("Shop");
	// The model's second call got what the server returned.
	expect(JSON.stringify(calls[1].messages)).toContain("2 blue mugs");
});

test("finds a tool with a search, then calls it", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({
		match: order,
		steps: [
			{ toolCalls: [{ name: "connector_search", input: { query: "find order" } }] },
			{ toolCalls: [call("shop__find_order", { order })] },
			{ text: "Found it: 2 blue mugs." },
		],
	});

	await page.goto("/");
	await chat.send(page, `Look up order ${order}`);
	await expect(chat.reply(page)).toContainText("Found it: 2 blue mugs.");
	// Both steps read, so they fold as lookups.
	await chat.reply(page).getByText("Looked up 2 things").click();
	await expect(chat.reply(page).getByText("Searched connectors for “find order”")).toBeVisible();
	await expect(chat.reply(page).getByText("Shop · Find order")).toBeVisible();

	// The search gave the tool's exact name and signature.
	const calls = await fake.calls(order);
	expect(JSON.stringify(calls[1].messages)).toContain("shop__find_order({ order: string })");
	expect(await serverCalls(page, order)).toHaveLength(1);
});

test("asks before a tool that changes something, and runs it once allowed", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({
		match: order,
		steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }],
	});

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	// The card shows the real tool's input, not connector_call's.
	const card = page.locator("[data-slot=confirmation]");
	await card.getByText("Show details").click();
	await expect(card).toContainText("Gift wrap");
	await expect(card).not.toContainText("shop__add_note");
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
		steps: [{ toolCalls: [call("shop__add_note", { order, note: "Rush" })] }, { text: "OK, I left the order as it was." }],
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
	const steps = [{ toolCalls: [call("shop__add_note", { order, note: "Fragile" })] }, { text: "Noted." }];
	await fake.chat({ match: order, steps });

	await page.goto("/");
	await chat.send(page, `Mark order ${order} as fragile`);
	await page.getByRole("button", { name: "Always allow" }).click();
	await expect(chat.reply(page)).toContainText("Noted.");

	await chat.send(page, `Mark order ${order} as fragile again`);
	await expect(chat.reply(page)).toContainText("Noted.");
	await expect(page.getByRole("button", { name: "Always allow" })).toHaveCount(0);
	expect(await serverCalls(page, order)).toHaveLength(2);
	// "Always allow" saved the rule of the tool behind connector_call.
	const [shop] = (await (await page.request.get("/api/connectors")).json()).connectors;
	expect(shop.tools.find((tool: { name: string }) => tool.name === "add_note").rule).toBe("allow");
});

test("checks a call's input against the tool before it asks", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order })] }, { text: "Which note should I add?" }] });

	await page.goto("/");
	await chat.send(page, `Add a note to order ${order}`);
	await expect(chat.reply(page)).toContainText("Which note should I add?");
	await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
	expect(await serverCalls(page, order)).toEqual([]);
	// The model read what was wrong, and the tool's signature.
	const sent = JSON.stringify((await fake.calls(order))[1].messages);
	expect(sent).toContain('missing the required property \\"note\\"');
	expect(sent).toMatch(/Signature: shop__add_note\(\{ [^)]*note: string/);
});

test("keeps the instructions and tools the same when the person adds a connector", async ({ page, fake }) => {
	await addShop(page);
	const first = `Cache check ${orderNumber()}`;
	await page.goto("/");
	await chat.send(page, first);
	await chat.idle(page);

	const response = await page.request.post("/api/connectors", {
		data: { name: "Back office", url: KEY, transport: "http", auth: "headers", headers: [{ name: "Authorization", value: `Bearer ${SHOP_KEY}` }] },
	});
	expect(response.ok(), await response.text()).toBe(true);
	const second = `Cache check ${orderNumber()}`;
	await page.goto("/");
	await chat.send(page, second);
	await chat.idle(page);

	const [before] = await fake.calls(first);
	const [after] = await fake.calls(second);
	// The start of the prompt is the same, so the provider's cache still has it.
	expect(after.system).toBe(before.system);
	expect(after.tools).toEqual(before.tools);
	// Only the note with the person's latest message names the new connector.
	expect(JSON.stringify(before.messages)).not.toContain("back_office");
	expect(JSON.stringify(after.messages.at(-1))).toContain("back_office__find_order");
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
	expect(call.tools).not.toContain("connector_call");
	expect(JSON.stringify(call.messages)).not.toContain("<connectors>");
	expect(await (await otherPage.request.get("/api/connectors")).json()).toEqual({ connectors: [] });
	await other.close();
});
