import { createLibrary, defineComponent, tagSchemaId, type Library, type PromptOptions } from "@openuidev/lang-core";
import { z } from "zod";

/**
 * Cards in a reply: the model writes OpenUI Lang (openui.com), a short line-based language
 * for UI, into the show_ui tool, and the chat draws it with frappe-ui while it streams.
 *
 * The components follow frappe-ui's OpenUI library (frappe/frappe-ui#1329): the same names,
 * arguments in the same order, and frappe-ui's own words for values (theme, variant, amber).
 * Ponder adds Table and Col, for comparisons. When frappe-ui ships its library, the web side
 * can use it, and programs saved in chats keep drawing.
 *
 * One definition for both sides. The server builds the prompt and checks the model's code
 * with placeholder renderers (`genuiLibrary()`). The page passes the Vue components
 * (web/genui/renderers.ts).
 */
export const SHOW_UI = "show_ui";

export const COMPONENT_NAMES = [
	"Stack",
	"Row",
	"Heading",
	"Text",
	"Badge",
	"Alert",
	"Button",
	"Buttons",
	"NumberCard",
	"BarChart",
	"LineChart",
	"DonutChart",
	"List",
	"ListRow",
	"Table",
	"Col",
] as const;

export type GenuiComponentName = (typeof COMPONENT_NAMES)[number];
export type GenuiRenderers = Record<GenuiComponentName, unknown>;

// An Action([...]) expression. The tag gives it a readable type in the prompt and turns on the prompt's section on actions.
const action = z.any();
tagSchemaId(action, "ActionExpression");

// Rows: an array of objects that the model writes, one per category, date or item.
const rows = z.array(z.record(z.string(), z.any()));

const THEMES = ["gray", "blue", "green", "amber", "red", "violet"] as const;

export function genuiLibrary(renderers?: Partial<GenuiRenderers>): Library {
	const placeholder = { name: "GenuiPlaceholder", render: () => null };
	const define = <T extends z.ZodObject>(name: GenuiComponentName, description: string, props: T) =>
		defineComponent({ name, description, props, component: (renderers?.[name] ?? placeholder) as never });

	const Button = define(
		"Button",
		"A button. Without an action it sends its label to you, like a suggested reply.",
		z.object({
			label: z.string(),
			action: action.optional(),
			variant: z.enum(["solid", "subtle", "outline", "ghost"]).optional().describe("solid for the main action, subtle for the others"),
			theme: z.enum(["gray", "blue", "green", "red"]).optional(),
		}),
	);
	const ListRow = define(
		"ListRow",
		"One row of a List.",
		z.object({
			title: z.string(),
			description: z.string().optional(),
			aside: z.any().optional().describe("Shown at the end of the row: text or a Badge"),
		}),
	);
	const Col = define(
		"Col",
		"One column of a Table: its header, and the key of its value in each row.",
		z.object({
			label: z.string(),
			key: z.string(),
			format: z.enum(["text", "number", "currency", "percent", "date", "badge"]).optional().describe("currency: an amount in the Table's currency"),
		}),
	);
	const axis = z.object({
		data: rows,
		x: z.string().describe("Key of the category or date in each row"),
		y: z.union([z.string(), z.array(z.string())]).describe("Key, or keys, of the numbers in each row"),
		title: z.string().optional(),
	});

	return createLibrary({
		root: "Stack",
		components: [
			define("Stack", "Puts its children in a column. Use it as the root of every card.", z.object({ children: z.array(z.any()) })),
			define(
				"Row",
				"Puts its children side by side in equal columns, and wraps them on a phone. Use it for 2 to 4 NumberCards or small charts.",
				z.object({ children: z.array(z.any()) }),
			),
			define("Heading", "A section title.", z.object({ text: z.string() })),
			define("Text", "A paragraph of plain text.", z.object({ text: z.string() })),
			define(
				"Badge",
				"A short status label, such as a priority or a state.",
				z.object({
					label: z.union([z.string(), z.number()]),
					theme: z.enum(THEMES).optional().describe("red: urgent or failed, amber: warning, green: done"),
					variant: z.enum(["solid", "subtle", "outline", "ghost"]).optional(),
				}),
			),
			define(
				"Alert",
				"A note that needs attention: a warning, a caveat, or a key finding.",
				z.object({ title: z.string(), description: z.string().optional(), theme: z.enum(["gray", "blue", "green", "amber", "red"]).optional() }),
			),
			Button,
			define("Buttons", "A row of Buttons.", z.object({ buttons: z.array(Button.ref) })),
			define(
				"NumberCard",
				"One number with a title, such as a count, a total or a rate.",
				z.object({
					title: z.string(),
					value: z.union([z.number(), z.string()]),
					prefix: z.string().optional().describe('Printed before the value, e.g. "$"'),
					suffix: z.string().optional().describe('Printed after the value, e.g. "%"'),
					delta: z.number().optional().describe("Change against the previous period. Its sign sets the arrow."),
				}),
			),
			define(
				"BarChart",
				"Compares numbers across categories.",
				axis.extend({ stacked: z.boolean().optional(), horizontal: z.boolean().optional().describe("Use for long category names") }),
			),
			define("LineChart", "Shows how numbers change over time.", axis),
			define(
				"DonutChart",
				"Shows how a whole splits into parts. Use for 2 to 6 parts.",
				z.object({
					data: rows,
					category: z.string().describe("Key of the slice name in each row"),
					value: z.string().describe("Key of the slice size in each row"),
					title: z.string().optional(),
				}),
			),
			define("List", "A list of items, one ListRow each. Build the rows with @Each over an array of rows.", z.object({ rows: z.array(ListRow.ref) })),
			ListRow,
			define(
				"Table",
				"A table for comparing items on several points: one row per item, one Col per point.",
				z.object({ data: rows, columns: z.array(Col.ref), title: z.string().optional(), currency: z.string().optional().describe('ISO code for currency columns, e.g. "USD"; default USD') }),
			),
			Col,
		],
		componentGroups: [
			{ name: "Layout", components: ["Stack", "Row"] },
			{ name: "Content", components: ["Heading", "Text", "Badge", "Alert"] },
			{ name: "Actions", components: ["Button", "Buttons"] },
			{ name: "Data", components: ["NumberCard", "BarChart", "LineChart", "DonutChart", "List", "ListRow", "Table", "Col"] },
		],
	});
}

/**
 * Ponder's rules for the prompt. A card has no live queries: the model puts the data in the
 * program, from what it found with search, Python or a connector, or from what it knows well.
 * Bindings stay on for the expressions (@Each, @Filter, pluck) and for $variables that a
 * Button sets, such as a toggle between two views. There are no inputs or forms.
 */
export const GENUI_PROMPT_OPTIONS: PromptOptions = {
	preamble: `You draw cards in Ponder's chat with OpenUI Lang: code that the chat renders as components while you write it. Pass the code to the ${SHOW_UI} tool.`,
	toolCalls: false,
	bindings: true,
	additionalRules: [
		"Start with root = Stack([...]). Put each part in its own statement and refer to it by name.",
		"Write the data into the program once, as an array of rows, and pass it to every chart, list and table that shows it. Compute totals and counts with @Sum, @Count and @Filter.",
		"Use only figures you found in this chat (search results, pages, a Python run, a connector) or know well. Never make up figures. If a figure is an estimate, say so in a Text or an Alert.",
		"Keep a card to one clear view: a few NumberCards, one or two charts, a short table or list.",
		"To let the person switch views, declare a $variable and set it with Buttons, and mark the button of the view on show: Button(\"5G only\", Action([@Set($network, \"5G\")]), $network == \"5G\" ? \"subtle\" : \"ghost\").",
		"Use theme for meaning only: red for urgent or failed, amber for warnings, green for done. Use gray otherwise.",
		'Give a card at most one Button with variant "solid".',
		"Text in components is plain and short, with no Markdown.",
	],
	examples: [
		`root = Stack([title, kpis, chart, filters, table, next])
$network = "All"
title = Heading("Phone plans compared")
plans = [{plan: "Basic", price: 15, data: 5, network: "4G"}, {plan: "Plus", price: 25, data: 20, network: "5G"}, {plan: "Max", price: 40, data: 100, network: "5G"}]
shown = $network == "All" ? plans : @Filter(plans, "network", "==", $network)
kpis = Row([NumberCard("Cheapest", @Min(plans.price), "$"), NumberCard("Most data", @Max(plans.data), null, " GB")])
chart = BarChart(plans, "plan", "data", "Data per month (GB)")
filters = Buttons([Button("All", Action([@Set($network, "All")]), $network == "All" ? "subtle" : "ghost"), Button("5G only", Action([@Set($network, "5G")]), $network == "5G" ? "subtle" : "ghost")])
table = Table(shown, [Col("Plan", "plan"), Col("Price", "price", "currency"), Col("Data (GB)", "data", "number"), Col("Network", "network", "badge")])
next = Buttons([Button("Which plan fits me?", Action([@ToAssistant("Which of these plans fits me best?")]), "solid")])`,
		`root = Stack([title, chart, items])
title = Heading("Steps this week")
days = [{day: "Mon", steps: 6200}, {day: "Tue", steps: 8100}, {day: "Wed", steps: 4300}]
chart = LineChart(days, "day", "steps")
items = List(@Each(days, "d", ListRow(d.day, d.steps + " steps", Badge(d.steps >= 8000 ? "Goal met" : "Short", d.steps >= 8000 ? "green" : "gray"))))`,
	],
};

/** What the model reads before it draws: the syntax, the components and the built-ins. */
export function genuiPrompt(library = genuiLibrary()) {
	return library.prompt(GENUI_PROMPT_OPTIONS);
}
