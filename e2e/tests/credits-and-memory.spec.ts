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
