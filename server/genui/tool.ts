import { createParser, type ParseResult } from "@openuidev/lang-core";
import { tool } from "ai";
import { z } from "zod";
import { genuiLibrary, genuiPrompt, SHOW_UI } from "../../shared/genui.ts";

/**
 * show_ui: a card in the reply, written in OpenUI Lang (shared/genui.ts). The code is the
 * tool call's input, so it is saved with the message, and the page draws it while it
 * streams (web/genui/). Before the card is kept, the server parses it. A program that would
 * not draw as written (an unknown component, a wrong argument, a name used but never
 * defined, a part never placed) fails the call with a list of what to fix, and the model
 * draws the card again. A failed try shows as one quiet line, not a broken card.
 *
 * Parsing needs nothing outside the code and gives the same answer every time, so the tool
 * runs in the workflow, as write_artifact does, and is no step.
 */
export { SHOW_UI };

const library = genuiLibrary();
const parser = createParser(library.toJSONSchema(), library.root);

export const showUiInput = z.object({
	title: z.string().min(1).max(120).describe("What the card shows, in a few words, like Phone plans compared."),
	code: z.string().min(1).describe("The OpenUI Lang program, starting with root = Stack([...])."),
});

const DESCRIPTION =
	"Draw a card in the chat: figures, charts, a table, a list, or buttons with next steps, written in OpenUI Lang. " +
	"Use it when a picture answers better than prose: comparing options on several points, numbers over time, parts of a whole, a few headline figures. " +
	"Not for documents, slide decks or pages to keep (write_artifact), and not for a short answer. " +
	"Returns what to fix if the code would not draw. Once it returns without an error, the card is shown: do not draw it again unless the person asks for a change.";

export const GENUI_GUIDANCE = `You can draw a card in the reply with ${SHOW_UI}. A card shows data at a glance: a comparison table, a chart, a few headline figures, a list with statuses, and buttons for next steps. Draw one when the person asks for a chart or a comparison, or when the answer is mostly numbers or options to compare. Use the figures you found or computed first: search, read pages or run Python before you draw, and never make up data. After the card, add a sentence or two that says what it shows or what stands out; do not repeat the card's figures in text.

${genuiPrompt(library)}`;

export function genuiTools() {
	return {
		[SHOW_UI]: tool({
			description: DESCRIPTION,
			inputSchema: showUiInput,
			execute: async ({ title, code }) => {
				const problems = checkProgram(parser.parse(code));
				if (problems.length) throw new Error(`Fix the card and call ${SHOW_UI} again:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
				return { shown: true, title };
			},
		}),
	};
}

/** What stops a program from drawing as written. */
export function checkProgram(result: ParseResult) {
	const problems: string[] = [];
	if (!result.root) problems.push("There is no root. Start with root = Stack([...]).");
	for (const error of result.meta.errors) problems.push(`${error.statementId ? `${error.statementId}: ` : ""}${error.message}`);
	for (const name of result.meta.unresolved) problems.push(`"${name}" is used but never defined.`);
	for (const name of result.meta.orphaned) problems.push(`"${name}" is defined but not placed anywhere under root, so it would not show.`);
	if (result.queryStatements.length || result.mutationStatements.length) problems.push("Query() and Mutation() are not available. Write the data into the program.");
	return problems;
}
