import { Markdown, type MarkdownComponents } from "@astryxdesign/core/Markdown";
import { markdownSoftBreaksPlugin } from "@astryxdesign/core/Markdown/plugins";
import "./markdown.css";
import { bracketMathPlugin, dollarInlineMath, MathExpression } from "./math";
import { mermaidPlugin } from "./mermaid";

// One list for every instance: Astryx asks for a stable list while the syntax does not change.
// Single newlines are line breaks, as the model means them.
const plugins = [markdownSoftBreaksPlugin, bracketMathPlugin, mermaidPlugin];

/** The renderers every model Markdown uses. Add to a copy of it, made once, as Reply does. */
export const chatMarkdownComponents: MarkdownComponents = { math: MathExpression };

/**
 * Markdown the model wrote (replies, reasoning, documents): LaTeX maths, ```mermaid
 * diagrams, and single newlines as line breaks.
 */
export default function ChatMarkdown({
	children,
	streaming = false,
	density,
	components = chatMarkdownComponents,
}: {
	children: string;
	streaming?: boolean;
	density?: "default" | "compact";
	components?: MarkdownComponents;
}) {
	return (
		<Markdown density={density} isStreaming={streaming} autolink="gfm" contentWidth="100%" plugins={plugins} components={components}>
			{dollarInlineMath(children)}
		</Markdown>
	);
}
