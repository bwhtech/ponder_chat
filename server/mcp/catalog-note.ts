import { unavailableText, type CatalogData, type CatalogTool } from "./catalog.ts";
import { signature } from "./signature.ts";

/**
 * The <connectors> note that goes with the person's latest message, as memory's does
 * (workflow/context.ts). It names the person's connectors, so the instructions and the
 * tool list never change when a connector does, and providers keep them cached. The
 * latest turn is sent uncached anyway.
 *
 * When every tool's line fits in TOOL_LINES_BUDGET, the note also lists the tools with
 * their signatures, so with a few tools the model calls one without a search first.
 * No Node imports: the workflow loads this file.
 */
const TOOL_LINES_BUDGET = 3_000;
const MAX_LINE_DESCRIPTION = 120;

export function connectorNote(catalog: CatalogData): string {
	if (!catalog.connectors.length) return "";
	const usable = catalog.connectors.filter((connector) => !connector.unavailable);
	const unavailable = catalog.connectors.filter((connector) => connector.unavailable);
	const toolLines = catalog.tools.map(toolLine);
	const listsTools = toolLines.length > 0 && toolLines.join("\n").length <= TOOL_LINES_BUDGET;
	return [
		"<connectors>",
		"The apps the person connected to Ponder. Their tools are named <slug>__<tool>.",
		...(usable.length ? usable.map((connector) => `- ${clean(connector.slug)}: ${clean(connector.name)}${connector.server && connector.server !== connector.name ? ` (${clean(connector.server)})` : ""}, ${plural(connector.tools, "tool")}`) : []),
		...unavailable.map((connector) => `- ${clean(connector.slug)}: no tools now. ${clean(unavailableText(connector))}`),
		...(listsTools ? ["All their tools, so you can call one with connector_call without a search:", ...toolLines] : []),
		...(!listsTools && catalog.tools.length ? ["Find their tools with connector_search, then call one with connector_call."] : []),
		...(catalog.leftOut ? [`The person has too many tools on, so Ponder left out ${plural(catalog.leftOut, "tool")}. If one you need is missing, ask them to turn off tools they don't use in Settings, Connectors.`] : []),
		"</connectors>",
	].join("\n");
}

/** The whole line is cleaned: the server wrote the description and every part of the signature. */
function toolLine(tool: CatalogTool) {
	const about = firstLine(tool.title && tool.description ? `${tool.title}. ${tool.description}` : tool.title || tool.description);
	return clean(`- ${signature(tool.name, tool.inputSchema)}${about ? `: ${about}` : ""}${tool.ask ? " (asks the person first)" : ""}`);
}

function firstLine(text: string) {
	const line = text.split("\n")[0]!.trim();
	return line.length > MAX_LINE_DESCRIPTION ? `${line.slice(0, MAX_LINE_DESCRIPTION - 1)}…` : line;
}

/** A name or a server's text can't close the note or open a tag in it. */
const clean = (text: string) => text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;
