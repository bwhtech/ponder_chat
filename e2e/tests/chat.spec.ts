import { chat, expect, jsonOf, test } from "../fixtures.ts";
import { createWorkspace } from "../workspaces.ts";

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

test("a new chat starts on Auto, which picks from Ponder's models", async ({ page, fake }) => {
	await expect(page.getByRole("button", { name: "Model: Auto" })).toBeVisible();
	await chat.send(page, "Who answers this, auto test?");
	await expect(chat.reply(page)).toContainText("You said:");
	await chat.idle(page);
	// Under Auto the reply names no model.
	await expect(chat.reply(page).locator('[data-slot="reply-model"]')).toHaveCount(0);

	const [call] = await fake.calls("auto test");
	expect(call.model).toBe("openrouter/auto");
	expect(call.system).toContain("You run on a model that OpenRouter's Auto Router picks");
	expect(call.provider).toMatchObject({ zdr: true, data_collection: "deny" });
	const router = call.plugins.find((plugin) => (plugin as { id: string }).id === "auto-router") as { allowed_models: string[]; cost_tier: string };
	// Admins set it (admin.spec.ts changes it for a moment, so only its presence here).
	expect(["low", "medium", "high"]).toContain(router.cost_tier);
	expect(router.allowed_models).toContain("anthropic/claude-haiku-5.5");
	expect(router.allowed_models).not.toContain("openrouter/auto");
	// The chat is the session, so Auto keeps a chat on one model where it can.
	expect(call.sessionId).toBe(new URL(page.url()).searchParams.get("t"));
});

test("an Auto reply stays on the model that answered, through its tool steps", async ({ page, fake }) => {
	await fake.chat({ match: "pinned test", steps: [{ toolCalls: [{ name: "web_search", input: { query: "pinned" } }] }, { text: "Found it." }] });
	await chat.send(page, "Search this, pinned test");
	await expect(chat.reply(page)).toContainText("Found it.");
	await chat.idle(page);

	const calls = await fake.calls("pinned test");
	// The second call carries the first call's tool call and its signed reasoning, so it goes to the model that wrote them.
	expect(calls.map((call) => call.model)).toEqual(["openrouter/auto", "anthropic/claude-haiku-5.5"]);
	expect(calls[1].plugins).not.toContainEqual(expect.objectContaining({ id: "auto-router" }));
});

test("asks the model the person picked", async ({ page, fake }) => {
	await page.getByRole("button", { name: /^Model:/ }).click();
	await page.getByRole("option", { name: /Claude Haiku 5\.5/ }).click();

	await chat.send(page, "Which model are you, picker test?");
	await expect(chat.reply(page)).toContainText("You said:");
	await chat.idle(page);
	await expect(chat.reply(page).locator('[data-slot="reply-model"]')).toHaveText("Claude Haiku 5.5");

	const [call] = await fake.calls("picker test");
	expect(call.model).toBe("anthropic/claude-haiku-5.5");
	expect(call.system).toContain("You run on Claude Haiku 5.5");
	// Only to endpoints that keep no data (server/openrouter/OpenRouter.ts).
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
	await page.getByRole("button", { name: "New chat", exact: true }).click();
	await expect(page.getByText("What's on your mind?")).toBeVisible();
	await expect(chat.messages(page)).toHaveCount(0);
});

test("a chat keeps every message after a workspace page, and sends with all of them", async ({ page, person, fake }) => {
	test.setTimeout(60_000);
	const name = `Returns ${person.id.slice(0, 6)}`;
	await createWorkspace(page, name);
	// The new workspace shows in the list after a reload.
	await page.reload();
	// A reply that fails, and Retry: the chat's messages are a new list from then on.
	await fake.chat({ match: "First question, return test", steps: [{ error: { status: 400, message: "The provider refused the request." } }] });
	await chat.send(page, "First question, return test");
	await expect(page.getByText("Something went wrong")).toBeVisible();
	await fake.chat({ match: "First question, return test", steps: [{ text: "It works now." }] });
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(chat.reply(page)).toContainText("It works now.");
	await chat.idle(page);
	const id = new URL(page.url()).searchParams.get("t")!;
	await chat.send(page, "Second question, return test");
	await expect(chat.reply(page)).toContainText("You said: Second question");
	await chat.idle(page);
	await expect(chat.messages(page)).toHaveCount(4);

	const workspaceRow = page.locator('[data-slot="workspace-rows"]').getByRole("button", { name, exact: true });
	const threadRow = page.getByRole("navigation", { name: "Threads" }).getByText("First question, return test");
	const workspaceHeading = page.getByRole("heading", { name, level: 1 });
	const openWorkspace = async () => {
		await workspaceRow.click();
		await expect(workspaceHeading).toBeVisible();
	};
	const ways: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
		["a workspace page, then the chat in the list", openWorkspace, () => threadRow.click()],
		["a workspace page, then Back", openWorkspace, () => page.goBack()],
	];
	for (const [title, away, back] of ways) {
		await test.step(title, async () => {
			await away();
			await back();
			await expect(page).toHaveURL(new RegExp(`[?&]t=${id}`));
			await expect(chat.messages(page)).toHaveCount(4);
		});
	}

	// The next reply goes on from all 4 messages, and the server keeps 6.
	await chat.send(page, "Third question, return test");
	await expect(chat.reply(page)).toContainText("You said: Third question");
	await chat.idle(page);
	const saved = async () => (await jsonOf<{ messages: unknown[] }>(await page.request.get(`/api/threads/${id}`))).messages.length;
	await expect.poll(saved).toBe(6);
});
