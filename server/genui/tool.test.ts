/**
 * show_ui checks a card before it is kept (server/genui/tool.ts): the prompt's own examples
 * pass, and a program that would not draw as written fails with what to fix.
 */
import { describe, expect, it } from "vitest";
import { GENUI_PROMPT_OPTIONS } from "../../shared/genui.ts";
import { GENUI_GUIDANCE, genuiTools, SHOW_UI } from "./tool.ts";

const showUi = genuiTools()[SHOW_UI];
const draw = (code: string) => showUi.execute!({ title: "Test", code }, { toolCallId: "t1", messages: [], context: undefined as never });

describe("show_ui", () => {
	it("accepts every example in the prompt", async () => {
		for (const code of GENUI_PROMPT_OPTIONS.examples ?? []) await expect(draw(code)).resolves.toEqual({ shown: true, title: "Test" });
	});

	it("teaches the model every component and no queries", () => {
		for (const name of ["Stack", "Row", "NumberCard", "BarChart", "LineChart", "DonutChart", "List", "Table", "Col", "Buttons"]) expect(GENUI_GUIDANCE).toContain(`${name}(`);
		expect(GENUI_GUIDANCE).not.toContain("Query(");
		expect(GENUI_GUIDANCE).not.toContain("Mutation(");
	});

	it.each([
		["an unknown component", 'root = Stack([x])\nx = Slider("a")', 'Unknown component "Slider"'],
		["a wrong argument", 'root = Stack([x])\nx = BarChart("rows", "a", "b")', 'expects array'],
		["a missing argument", "root = Stack([x])\nx = Heading()", "missing required field"],
		["a name never defined", "root = Stack([x, y])\nx = Text(\"hi\")", '"y" is used but never defined'],
		["a part never placed", 'root = Stack([x])\nx = Text("hi")\ny = Text("lost")', '"y" is defined but not placed'],
		["a query", 'root = Stack([t])\nq = Query("list", {}, [])\nt = Text("x")', "Query() and Mutation() are not available"],
		["no program", "Here is your chart.", "There is no root"],
	])("refuses %s", async (_, code, problem) => {
		await expect(draw(code)).rejects.toThrow(problem);
	});
});
