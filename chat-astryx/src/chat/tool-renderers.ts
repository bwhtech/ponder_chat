import type { UIMessage } from "ai";
import type { ComponentType } from "react";
import { createStore } from "../lib/store";

/**
 * Tool parts with a renderer of their own (run_python, web_search, write_artifact...).
 * Each feature module registers its component here, so MessageParts does not import it.
 * A tool without one shows as a row in ChatToolCalls.
 */
export type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

export type ToolRendererProps = {
	part: ToolPart;
	/** The tool's name, without the "tool-" prefix. */
	name: string;
	message: UIMessage;
	/** This reply is still being written. */
	streaming: boolean;
};

export type ToolRenderer = {
	component: ComponentType<ToolRendererProps>;
	/** Shown in the folded steps row with the calls around it (searches, page reads), rather than on its own. */
	foldable?: boolean;
};

export const toolRenderers = createStore<Record<string, ToolRenderer>>({});

export function registerToolRenderer(name: string, renderer: ToolRenderer) {
	toolRenderers.set((all) => ({ ...all, [name]: renderer }));
}

/**
 * Labels for tools from connectors ("Linear · Create issue") and what to ask before one
 * runs. Connectors register a lookup here; undefined means "use the tool's own name".
 */
export type ToolLabel = { title: string; question?: string; alwaysAllow?: () => Promise<void> };
export const toolLabeler = createStore<(name: string) => ToolLabel | undefined>(() => undefined);

export function toolName(part: ToolPart) {
	return part.type === "dynamic-tool" ? (part as { toolName: string }).toolName : part.type.slice("tool-".length);
}

/** "web_search" → "Web search". */
export function humanize(name: string) {
	const words = name.replace(/[_-]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
