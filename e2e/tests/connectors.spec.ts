import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import type { ConnectorView } from "../../shared/connectors.ts";
import type { McpCall } from "../mcp/calls.ts";
import { SHOP_KEY } from "../mcp/server.ts";
import { parseJson } from "../../server/test-json.ts";
import type { Step } from "../fake/script.ts";
import { chat, expect, jsonOf, randomIp, signIn, test, uniqueEmail, type Fake } from "../fixtures.ts";

/**
 * Connectors (Settings, Connectors) against the test MCP servers in e2e/mcp/server.ts:
 * adding one with no sign-in, with an API key and with OAuth, and the model finding and
 * using its tools through connector_search and connector_call, with and without the
 * person's approval. Each server's tools are find_order, which only reads, and add_note.
 */
const OPEN = `${e2e.mcpUrl}/open/mcp`;
const KEY = `${e2e.mcpUrl}/key/mcp`;
const OAUTH = `${e2e.mcpOAuthUrl}/mcp`;

type Connectors = { connectors: ConnectorView[] };

/** An order number no other test uses: the servers are shared, and their calls are found by it. */
const orderNumber = () => `A${randomBytes(3).toString("hex")}`;

/** The tool calls that the test servers ran with this order. */
async function serverCalls(page: Page, order: string): Promise<McpCall[]> {
	return jsonOf(await page.request.get(`${e2e.mcpUrl}/__mcp/calls?match=${order}`));
}

/** A model's call to a connector tool, through connector_call. */
const call = (tool: string, input: Record<string, unknown>) => ({ name: "connector_call", input: { tool, input } });

/** A chat whose model asks to run a tool on "Ask first", open in a second tab too. The second tab. */
async function askInTwoTabs(page: Page, fake: Fake, order: string, steps: Step[]) {
	await addShop(page);
	await fake.chat({ match: order, steps });
	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	const other = await page.context().newPage();
	await other.goto(page.url());
	await expect(other.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	return other;
}

/** How many messages the page has sent from now on. A page that sends an answer again and again would show here. */
function chatPosts(page: Page) {
	let posts = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") posts++;
	});
	return () => posts;
}

async function savedMessages(page: Page, thread: string): Promise<unknown[]> {
	return (await jsonOf<{ messages: unknown[] }>(await page.request.get(`/api/threads/${thread}`))).messages;
}

/** Waits until the chat's reply is saved and its run finished: the page goes idle a moment before. The chat's id. */
async function replySaved(page: Page) {
	const thread = new URL(page.url()).searchParams.get("t")!;
	await expect
		.poll(async () => {
			const body = await jsonOf<{ running?: boolean }>(await page.request.get(`/api/threads/${thread}`));
			return body.running;
		})
		.toBe(false);
	return thread;
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

test("runs the call the person allows, and not the one they deny, in the same reply", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({
		match: order,
		steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" }), call("shop__add_note", { order, note: "Rush" })] }, { text: "I added one note." }],
	});

	await page.goto("/");
	await chat.send(page, `Add two notes to order ${order}`);
	const cards = page.locator("[data-slot=confirmation]");
	await expect(cards).toHaveCount(2);
	await cards.first().getByRole("button", { name: "Allow once" }).click();
	// An answered question folds away, so the one left is the second.
	await expect(cards).toHaveCount(1);
	await expect(cards).toContainText("Rush");
	await cards.getByRole("button", { name: "Deny" }).click();

	await expect(chat.reply(page)).toContainText("I added one note.");
	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ tool: "add_note", args: { order, note: "Gift wrap" } })]);
	expect(JSON.stringify((await fake.calls(order))[1].messages)).toContain("The person denied this.");
});

test("an approval answered in two tabs runs the call once", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }] });

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	// The same chat in a second tab, while the question waits.
	const other = await page.context().newPage();
	await other.goto(page.url());
	await expect(other.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();

	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(chat.reply(page)).toContainText("I added the note.");
	await replySaved(page);
	await other.getByRole("button", { name: "Allow once" }).click();
	// The second tab shows what the first answer did, and sends nothing more.
	await expect(chat.reply(other)).toContainText("I added the note.");
	await chat.idle(other);
	expect(await serverCalls(page, order)).toHaveLength(1);
	// The saved reply is the one the first answer wrote.
	await other.reload();
	await expect(chat.reply(other)).toContainText("I added the note.");
	expect(await serverCalls(page, order)).toHaveLength(1);
});

test("an approved chat sent again after its reply finished runs nothing again", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }] });

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	const answer = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/chat");
	await page.getByRole("button", { name: "Allow once" }).click();
	const approved: unknown = (await answer).postDataJSON();
	await expect(chat.reply(page)).toContainText("I added the note.");
	const thread = await replySaved(page);

	const again = await page.request.post("/api/chat", { data: approved });
	expect(again.ok(), await again.text()).toBe(true);
	// It answers with the reply that the first request started, and starts no run.
	expect(await again.text()).toContain(`"type":"tool-output-available"`);
	expect(await again.text()).toContain(`Added the note to order ${order}.`);
	expect(await serverCalls(page, order)).toHaveLength(1);
	const saved = await jsonOf<{ messages: { role: string }[]; running: boolean }>(await page.request.get(`/api/threads/${thread}`));
	expect(saved.running).toBe(false);
	expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	expect(JSON.stringify(saved.messages)).toContain("I added the note.");
	expect(await fake.calls(order)).toHaveLength(2);
});

test("Stop in the middle of an approved call, then the old card in another tab: no second call", async ({ page, fake }) => {
	const order = `SLOW${orderNumber()}`;
	const other = await askInTwoTabs(page, fake, order, [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }]);

	await page.getByRole("button", { name: "Allow once" }).click();
	// The test server takes 6 seconds over a SLOW order, and records the call first (e2e/mcp/server.ts).
	await expect.poll(() => serverCalls(page, order)).toHaveLength(1);
	await chat.stop(page).click();
	await replySaved(page);
	const posts = chatPosts(other);
	await other.getByRole("button", { name: "Allow once" }).click();

	// The second tab sends once. The saved thread says the call may or may not have taken effect.
	const thread = new URL(page.url()).searchParams.get("t")!;
	await expect.poll(async () => JSON.stringify(await savedMessages(page, thread))).toContain("may or may not have taken effect");
	await chat.idle(other);
	expect(posts()).toBe(1);
	await expect.poll(() => serverCalls(page, order), { timeout: 10_000 }).toHaveLength(1);
});

test("an old card answered after Stop and a newer message runs nothing", async ({ page, fake }) => {
	const order = `SLOW${orderNumber()}`;
	const other = await askInTwoTabs(page, fake, order, [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }]);

	await page.getByRole("button", { name: "Allow once" }).click();
	await expect.poll(() => serverCalls(page, order)).toHaveLength(1);
	await chat.stop(page).click();
	await replySaved(page);
	await fake.chat({ match: `Thanks ${order}`, steps: [{ text: "You are welcome." }] });
	await chat.send(page, `Thanks ${order}`);
	await expect(chat.reply(page)).toContainText("You are welcome.");
	const thread = await replySaved(page);
	const before = await savedMessages(page, thread);

	await other.getByRole("button", { name: "Allow once" }).click();
	// The second tab loads the thread as it is saved, with the newer reply.
	await expect(chat.reply(other)).toContainText("You are welcome.");
	await chat.idle(other);
	expect(await serverCalls(page, order)).toHaveLength(1);
	expect((await savedMessages(page, thread)).length).toBe(before.length);
});

test("an old card answered after Retry replaced the reply runs nothing, and the new reply stays", async ({ page, fake }) => {
	const order = orderNumber();
	const other = await askInTwoTabs(page, fake, order, [
		{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] },
		{ error: { status: 400, message: "The provider refused the request." } },
	]);

	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await replySaved(page);
	expect(await serverCalls(page, order)).toHaveLength(1);
	await fake.chat({ match: order, steps: [{ text: "Recovered without another write." }] });
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chat.reply(page)).toContainText("Recovered without another write.");
	const thread = await replySaved(page);
	const before = await savedMessages(page, thread);

	await other.getByRole("button", { name: "Allow once" }).click();
	await expect(chat.reply(other)).toContainText("Recovered without another write.");
	await chat.idle(other);
	expect(await serverCalls(page, order)).toHaveLength(1);
	expect(await savedMessages(page, thread)).toEqual(before);
});

test("an old card answered after the chat was deleted runs nothing, and the chat stays deleted", async ({ page, fake }) => {
	const order = orderNumber();
	const other = await askInTwoTabs(page, fake, order, [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }]);
	const thread = new URL(page.url()).searchParams.get("t")!;
	expect((await page.request.delete(`/api/threads/${thread}`)).ok()).toBe(true);

	await other.getByRole("button", { name: "Allow once" }).click();
	await chat.idle(other);
	expect(await serverCalls(page, order)).toEqual([]);
	expect(await savedMessages(page, thread)).toEqual([]);
});

test("an approval sent again under another message id runs nothing", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }] });
	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	const answer = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/chat");
	await page.getByRole("button", { name: "Allow once" }).click();
	const approved = parseJson<{ messages: { id: string }[] }>((await answer).postData() ?? "");
	await expect(chat.reply(page)).toContainText("I added the note.");
	await replySaved(page);

	approved.messages.at(-1)!.id = "crafted";
	expect((await page.request.post("/api/chat", { data: approved })).ok()).toBe(true);
	expect(await serverCalls(page, order)).toHaveLength(1);
});

test("keeps a question after a reload, and runs the call once allowed", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order, note: "Gift wrap" })] }, { text: "I added the note." }] });

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	// The question comes back from the saved reply, with its signature.
	await page.reload();
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	await page.getByRole("button", { name: "Allow once" }).click();

	await expect(chat.reply(page)).toContainText("I added the note.");
	expect(await serverCalls(page, order)).toEqual([expect.objectContaining({ tool: "add_note", args: { order, note: "Gift wrap" } })]);
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
	const [shop] = (await jsonOf<Connectors>(await page.request.get("/api/connectors"))).connectors;
	expect(shop.tools.find((tool) => tool.name === "add_note")?.rule).toBe("allow");
});

test("does not run a call that the person allows after turning its tool off", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__add_note", { order, note: "Late" })] }, { text: "That tool is off now." }] });

	await page.goto("/");
	await chat.send(page, `Add a late note to order ${order}`);
	await expect(page.getByText("Allow Ponder to use Shop: Add note?")).toBeVisible();
	// While the approval waits, the person turns the tool off in another tab.
	const [shop] = (await jsonOf<Connectors>(await page.request.get("/api/connectors"))).connectors;
	const off = await page.request.patch(`/api/connectors/${shop.id}`, { data: { rules: { add_note: "off" } } });
	expect(off.ok(), await off.text()).toBe(true);
	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(chat.reply(page)).toContainText("That tool is off now.");

	expect(await serverCalls(page, order)).toEqual([]);
	// The model reads a short reason, not an input error or the SDK's error names.
	const sent = JSON.stringify((await fake.calls(order))[1].messages);
	expect(sent).not.toMatch(/AI_\w+Error|Type validation failed|Invalid input for|Closest tools/);
	expect(sent).toContain("The person turned shop__add_note off in Settings, Connectors, so this call did not run.");
	// The page shows a call that did not run, not a change.
	await expect(chat.reply(page)).not.toContainText("change");
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

test("does not ask about a call whose input the model's output limit cut off", async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	const cut = { ...call("shop__add_note", { order, note: "A note long enough to be cut" }), cutAfter: 30 };
	await fake.chat({ match: order, steps: [{ toolCalls: [cut] }, { text: "My note was cut off." }] });

	await page.goto("/");
	await chat.send(page, `Add a long note to order ${order}`);
	await expect(chat.reply(page)).toContainText("My note was cut off.");
	// OpenRouter sends the cut input as {}, which the tool's check refuses before anything asks.
	await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
	expect(await serverCalls(page, order)).toEqual([]);
});

test(`does not run an "Ask first" tool called by a padded name`, async ({ page, fake }) => {
	await addShop(page);
	const order = orderNumber();
	for (const name of ["shop__add_note ", "\nshop__add_note"]) {
		await fake.chat({ match: `${order} ${JSON.stringify(name)}`, steps: [{ toolCalls: [call(name, { order, note: "Padded" })] }, { text: "That did not work." }] });
	}

	await page.goto("/");
	for (const name of ["shop__add_note ", "\nshop__add_note"]) {
		await chat.send(page, `Add a note to order ${order} ${JSON.stringify(name)}`);
		await expect(chat.reply(page)).toContainText("That did not work.");
	}
	// No approval was asked for, and the server ran nothing: the name is not the tool's.
	await expect(page.getByRole("button", { name: "Allow once" })).toHaveCount(0);
	expect(await serverCalls(page, order)).toEqual([]);
	expect(JSON.stringify((await fake.calls(order))[1].messages)).toContain("No connector tool is named");
});

test("does not run a tool that the person turned off", async ({ page, fake }) => {
	await addShop(page);
	const [shop] = (await jsonOf<Connectors>(await page.request.get("/api/connectors"))).connectors;
	const off = await page.request.patch(`/api/connectors/${shop.id}`, { data: { rules: { find_order: "off" } } });
	expect(off.ok(), await off.text()).toBe(true);
	const order = orderNumber();
	await fake.chat({ match: order, steps: [{ toolCalls: [call("shop__find_order", { order })] }, { text: "I can't look that up." }] });

	await page.goto("/");
	await chat.send(page, `Where is order ${order}?`);
	await expect(chat.reply(page)).toContainText("I can't look that up.");
	expect(await serverCalls(page, order)).toEqual([]);
	const [first, second] = await fake.calls(order);
	// The tool is not in the catalog: the note leaves it out, and the call says it is off.
	expect(JSON.stringify(first.messages)).not.toContain("shop__find_order(");
	expect(JSON.stringify(second.messages)).toContain("The person turned shop__find_order off in Settings, Connectors, so this call did not run.");
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
