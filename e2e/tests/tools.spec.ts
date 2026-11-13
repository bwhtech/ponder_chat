import { chat, expect, test } from "../fixtures.ts";

test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

test("searches the web and cites the page it found", async ({ page, fake }) => {
	const url = "https://blog.example.com/vue-release";
	await fake.search({ match: "vue release", results: [{ url, title: "Vue release notes", content: "Vue 9 came out today." }] });
	await fake.chat({
		match: "Which Vue",
		steps: [{ toolCalls: [{ name: "web_search", input: { query: "vue release" } }] }, { text: `Vue 9 is the newest ([Example blog](${url})).` }],
	});

	await chat.send(page, "Which Vue version is newest?");
	const reply = chat.reply(page);
	await expect(reply.locator(`a[href="${url}"]`)).toBeVisible();
	await expect(reply.locator("[data-trace-trigger]").first()).toBeVisible();

	// The model's second call got the search results as the tool's output.
	const calls = await fake.calls("Which Vue");
	expect(calls).toHaveLength(2);
	expect(JSON.stringify(calls[1].messages)).toContain("Vue 9 came out today.");
});

test("writes a document that opens in the side panel", async ({ page, fake }) => {
	await fake.chat({
		match: "packing list",
		steps: [
			{
				toolCalls: [
					{
						name: "write_artifact",
						input: { id: "packing-list", kind: "document", title: "Packing list", content: "# Packing list\n\n- Sun hat\n- Water bottle" },
					},
				],
			},
			{ text: "I wrote a packing list." },
		],
	});

	await chat.send(page, "Make me a packing list");
	await expect(chat.reply(page)).toContainText("I wrote a packing list.");
	await page.getByRole("button", { name: "Open Packing list" }).click();
	await expect(page.getByText("Water bottle")).toBeVisible();
});

test("a call to a tool that does not exist gets one error result, and the reply goes on", async ({ page, fake }) => {
	await fake.chat({ match: "ghost tool", steps: [{ toolCalls: [{ name: "no_such_tool", input: {} }] }, { text: "That tool does not exist." }] });

	await chat.send(page, "Use the ghost tool");
	await expect(chat.reply(page)).toContainText("That tool does not exist.");

	// The model's second call has one result for the call, the SDK's error, and nothing ran.
	const [, second] = await fake.calls("ghost tool");
	const results = (second.messages as { role: string }[]).filter((message) => message.role === "tool");
	expect(results).toHaveLength(1);
	expect(JSON.stringify(results)).toContain("unavailable tool");
});

test("offers the tools the chat has", async ({ page, fake }) => {
	await chat.send(page, "Which tools, tools test?");
	await chat.idle(page);
	const [call] = await fake.calls("tools test");
	expect(call.tools).toEqual(expect.arrayContaining(["web_search", "web_fetch", "write_artifact"]));
});
