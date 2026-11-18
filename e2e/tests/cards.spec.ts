import { chat, expect, test } from "../fixtures.ts";

/**
 * Cards in a reply (show_ui, server/genui/tool.ts): the server checks the program before
 * the card is kept, the page draws it with frappe-ui, and its buttons work.
 */
test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

const CARD = `root = Stack([title, kpis, tabs, table, next])
$network = "All"
title = Heading("Phone plans compared")
plans = [{plan: "Basic", price: 15, data: 5, network: "4G"}, {plan: "Plus", price: 25, data: 20, network: "5G"}, {plan: "Max", price: 40, data: 100, network: "5G"}]
shown = $network == "All" ? plans : @Filter(plans, "network", "==", $network)
kpis = Row([NumberCard("Cheapest", @Min(plans.price), "$"), NumberCard("Plans", @Count(shown))])
tabs = TabButtons(["All", "4G", "5G"], $network)
table = Table(shown, [Col("Plan", "plan"), Col("Price", "price", "currency"), Col("Network", "network", "badge")])
next = Buttons([Button("Which plan fits me?", Action([@ToAssistant("Which of these plans fits me best?")]), "solid")])`;

test("a card that would not draw goes back to the model, and the next one draws", async ({ page, fake }) => {
	await fake.chat({
		match: "compare plans",
		steps: [
			{ toolCalls: [{ name: "show_ui", input: { title: "Phone plans", code: 'root = Stack([chart])\nchart = PieChart("plans")' } }] },
			{ toolCalls: [{ name: "show_ui", input: { title: "Phone plans", code: CARD } }] },
			{ text: "Plus is the middle option." },
		],
	});
	await fake.chat({ match: "fits me best", steps: [{ text: "Plus fits most people." }] });

	await chat.send(page, "Please compare plans for me");
	const reply = chat.reply(page);
	await expect(reply).toContainText("Plus is the middle option.");

	// The failed try is one line; the model read what to fix.
	await expect(reply.getByText("Could not draw “Phone plans”")).toBeVisible();
	const calls = await fake.calls("compare plans");
	expect(JSON.stringify(calls[1].messages)).toContain('Unknown component \\"PieChart\\"');

	// The card: frappe-ui's NumberCard and List, with the data the program computed.
	const card = reply.locator('[data-slot="genui-card"]');
	await expect(card.getByText("Phone plans compared")).toBeVisible();
	await expect(card.locator('[data-slot="list-header"]')).toContainText("Price");
	await expect(card.getByText("$40")).toBeVisible();
	await expect(card.getByText("Basic")).toBeVisible();

	// TabButtons bound to a $variable filter the table in place, and show which view is on.
	const tab = (name: string) => card.getByRole("radio", { name, exact: true });
	await expect(tab("All")).toBeChecked();
	await tab("5G").click();
	await expect(tab("5G")).toBeChecked();
	await expect(card.getByText("Basic")).toBeHidden();
	await expect(card.getByText("Max")).toBeVisible();

	// A button with @ToAssistant sends its message, as if the person typed it.
	await card.getByRole("button", { name: "Which plan fits me?" }).click();
	await expect(chat.messages(page).filter({ hasText: "Which of these plans fits me best?" })).toBeVisible();
	await expect(chat.reply(page)).toContainText("Plus fits most people.");
});

test("a card draws again when the chat opens again", async ({ page, fake }) => {
	await fake.chat({ match: "saved card", steps: [{ toolCalls: [{ name: "show_ui", input: { title: "Plans", code: CARD } }] }, { text: "Here they are." }] });
	await chat.send(page, "Show the saved card");
	await expect(chat.reply(page)).toContainText("Here they are.");

	await page.reload();
	await expect(chat.reply(page).locator('[data-slot="genui-card"]').getByText("Phone plans compared")).toBeVisible();
});
