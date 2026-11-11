import { chat, expect, test } from "../fixtures.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("streams a reply in Markdown, and keeps the chat after a reload", async ({ page, fake }) => {
	await fake.chat({
		match: "planets table",
		steps: [
			{
				text: [
					"Here are three planets.",
					"",
					"| Planet | Moons |",
					"| --- | --- |",
					"| Earth | 1 |",
					"| Mars | 2 |",
					"| Jupiter | 95 |",
				].join("\n"),
			},
		],
	});

	await chat.send(page, "Show me a planets table");
	const reply = chat.reply(page);
	await expect(reply.locator("table")).toContainText("Jupiter");
	await chat.idle(page);

	// The fake names the chat from the message's first words (thread-title.ts).
	await expect(page.getByRole("navigation").getByText("Show me a planets table")).toBeVisible();

	await page.reload();
	await expect(chat.messages(page)).toHaveCount(2);
	await expect(chat.reply(page).locator("table")).toContainText("Jupiter");
});

test("the field is empty once the message is sent", async ({ page }) => {
	await chat.send(page, "Hello there");
	await expect(chat.reply(page)).toContainText("You said: Hello there");
	await expect(chat.field(page)).toHaveValue("");
});

test("asks the model the person picked", async ({ page, fake }) => {
	await page.getByRole("button", { name: /Model/ }).click();
	await page.getByRole("option", { name: /Claude Haiku 5\.5/ }).click();

	await chat.send(page, "Which model are you, picker test?");
	await expect(chat.reply(page)).toContainText("You said:");
	await chat.idle(page);
	await expect(chat.reply(page).locator('[data-slot="reply-model"]')).toHaveText("Claude Haiku 5.5");

	const [call] = await fake.calls("picker test");
	expect(call.model).toBe("anthropic/claude-haiku-5.5");
	expect(call.system).toContain("You run on Claude Haiku 5.5");
	// Only to endpoints that keep no data (server/openrouter.ts).
	expect(call.provider).toMatchObject({ zdr: true, data_collection: "deny" });
});

test("sends the earlier turns with a follow-up", async ({ page, fake }) => {
	await chat.send(page, "First question, follow-up test");
	await chat.idle(page);
	await chat.send(page, "Second question, follow-up test");
	await expect(chat.reply(page)).toContainText("You said: Second question");

	const calls = await fake.calls("Second question");
	const sent = JSON.stringify(calls[0].messages);
	expect(sent).toContain("First question");
	expect(sent).toContain("You said: First question");
});

test("Stop ends a reply that is still streaming", async ({ page, fake }) => {
	await fake.chat({ match: "long story", steps: [{ text: "Once upon a time ".repeat(200), delayMs: 100 }] });

	await chat.send(page, "Tell me a long story");
	await expect(chat.reply(page)).toContainText("Once upon a time");
	await chat.stop(page).click();
	await chat.idle(page);
	await expect(chat.submit(page)).toHaveAttribute("aria-label", "Send");

	// What came before Stop is kept, and the rest never comes.
	const kept = await chat.reply(page).innerText();
	expect(kept.length).toBeLessThan("Once upon a time ".repeat(200).length);
	await page.waitForTimeout(1000);
	expect(await chat.reply(page).innerText()).toBe(kept);
});

test("a failed reply shows Retry, and Retry answers", async ({ page, fake }) => {
	await fake.chat({ match: "flaky model", steps: [{ error: { status: 400, message: "The provider refused the request." } }] });

	await chat.send(page, "Ask the flaky model");
	const alert = page.getByText("Something went wrong");
	await expect(alert).toBeVisible();

	await fake.chat({ match: "flaky model", steps: [{ text: "It works now." }] });
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chat.reply(page)).toContainText("It works now.");
	await expect(alert).toHaveCount(0);
});

test("New chat starts an empty chat", async ({ page }) => {
	await chat.send(page, "A chat to leave");
	await chat.idle(page);
	await page.getByRole("button", { name: "New chat" }).click();
	await expect(page.getByText("What's on your mind?")).toBeVisible();
	await expect(chat.messages(page)).toHaveCount(0);
});
