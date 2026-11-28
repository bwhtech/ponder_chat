import { chat, expect, test } from "../fixtures.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("stops a person who used today's credits", async ({ page, fake }) => {
	// Credits are charged from the cost OpenRouter reports: $1 is far more than a day's credits.
	await fake.chat({ match: "expensive", steps: [{ text: "That was expensive.", cost: 1 }] });

	await chat.send(page, "An expensive question");
	await expect(chat.reply(page)).toContainText("That was expensive.");
	await expect(page.getByText("You've used today's credits")).toBeVisible();
	await expect(chat.field(page)).toBeDisabled();

	// The server refuses too, not only the page.
	const response = await page.request.post("/api/chat", {
		data: { id: "after-credits", messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "One more" }] }] },
	});
	expect(response.status()).toBe(402);
});

test("ends a reply when the credits run out between its model calls", async ({ page, fake }) => {
	await fake.chat({ match: "costly search", steps: [{ toolCalls: [{ name: "web_search", input: { query: "heat pumps" } }], cost: 1 }, { text: "Heat pumps save energy." }] });

	await chat.send(page, "A costly search");
	await expect(page.getByText("You've used today's credits")).toBeVisible();
	await expect(chat.reply(page)).not.toContainText("Heat pumps save energy.");
	expect(await fake.calls("costly search")).toHaveLength(1);
});

test("remembers what the person said, and recalls it in a new chat", async ({ page, fake }) => {
	await fake.memory({
		match: "green tea",
		save: 0.9,
		operations: [{ op: "add", kind: "preference", text: "Drinks green tea, not coffee.", quote: "I drink green tea" }],
	});

	await chat.send(page, "I drink green tea, never coffee. What goes with it?");
	await expect(page.locator('[data-slot="memory-note"]')).toContainText("Remembered: Drinks green tea, not coffee.");

	await page.getByRole("button", { name: "New chat" }).click();
	await chat.send(page, "Suggest a drink for the morning, recall test");
	await chat.idle(page);
	const [call] = await fake.calls("recall test");
	expect(JSON.stringify(call)).toContain("Drinks green tea, not coffee.");
});

test("the note under a reply opens Settings on Memory, where the person can open its chat or forget it", async ({ page, fake }) => {
	await fake.memory({
		match: "oolong",
		save: 0.9,
		operations: [{ op: "add", kind: "preference", text: "Likes oolong tea.", quote: "I like oolong" }],
	});
	await chat.send(page, "I like oolong tea. Any brewing tips?");
	const note = page.locator('[data-slot="memory-note"]');
	await expect(note).toContainText("Remembered: Likes oolong tea.");
	await chat.idle(page);
	const chatUrl = page.url();

	await note.click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
	await expect(settings.getByRole("heading", { name: "Memory" })).toBeVisible();
	const memory = settings.getByRole("listitem").filter({ hasText: "Likes oolong tea." });
	await expect(memory).toBeVisible();

	// "From “…”" opens the chat it came from, and Settings closes.
	await memory.getByRole("button", { name: /^From “/ }).click();
	await expect(settings).toHaveCount(0);
	await expect(page).toHaveURL(chatUrl);
	await expect(chat.messages(page)).toHaveCount(2);

	// Forget asks first, over Settings, then the list is empty.
	await note.click();
	await settings.getByRole("button", { name: "Actions for Likes oolong tea." }).click();
	await page.getByRole("menuitem", { name: "Forget" }).click();
	await page.getByRole("dialog", { name: "Forget this?" }).getByRole("button", { name: "Forget" }).click();
	await expect(settings.getByText("Nothing remembered yet")).toBeVisible();
	await expect(settings).toBeVisible();

	// Back and Forward change the chat under Settings, so Settings closes with them.
	await settings.getByRole("button", { name: "Close settings" }).click();
	await page.getByRole("button", { name: "New chat" }).click();
	await expect(page).not.toHaveURL(chatUrl);
	const newChatUrl = page.url();
	await page.goBack();
	await expect(page).toHaveURL(chatUrl);
	await note.click();
	await expect(settings).toBeVisible();
	await page.goForward();
	await expect(page).toHaveURL(newChatUrl);
	await expect(settings).toHaveCount(0);
	await expect(chat.messages(page)).toHaveCount(0);
});

test("the account menu has Settings but no Memory or Connectors, which are tabs in Settings", async ({ page }) => {
	await page.getByRole("button", { name: /Ponder Chat/ }).first().click();
	await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Memory" })).toHaveCount(0);
	await expect(page.getByRole("menuitem", { name: "Connectors" })).toHaveCount(0);

	await page.getByRole("menuitem", { name: "Settings" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("heading", { name: "Account" })).toBeVisible();
	await settings.getByRole("tab", { name: "Memory" }).click();
	await expect(settings.getByRole("heading", { name: "Memory" })).toBeVisible();
	await expect(settings.getByText("Nothing remembered yet")).toBeVisible();
	await settings.getByRole("radio", { name: "Decisions" }).click();
	await expect(settings.getByText("No decisions yet")).toBeVisible();
	await settings.getByRole("tab", { name: "Connectors" }).click();
	await expect(settings.getByRole("heading", { name: "Connectors" })).toBeVisible();
});

test("an older Memory link, ?view=memory, opens Settings on Memory over the chat", async ({ page }) => {
	await page.goto("/?view=memory");
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
	await expect(settings.getByRole("heading", { name: "Memory" })).toBeVisible();
	await expect(page).not.toHaveURL(/view=memory/);

	await settings.getByRole("button", { name: "Close settings" }).click();
	await expect(settings).toHaveCount(0);
	await expect(page.getByText("What's on your mind?")).toBeVisible();
});
