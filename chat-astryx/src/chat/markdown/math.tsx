import { createMarkdownPlugin, type MarkdownExtensionNode, type MarkdownSyntaxContribution } from "@astryxdesign/core/Markdown/plugins";
import { memo, useEffect, useMemo, useState } from "react";

type Tex = typeof import("./katex").tex;

let loaded: Tex | undefined;
let loading: Promise<Tex> | undefined;

// KaTeX and its fonts are big and most replies have no maths, so they load on first use.
function loadTex() {
	loading ??= import("./katex").then(
		(module) => (loaded = module.tex),
		(reason) => {
			loading = undefined;
			throw reason;
		},
	);
	return loading;
}

function useTex(source: string, display: boolean) {
	const [tex, setTex] = useState(() => loaded);
	useEffect(() => {
		if (tex) return;
		let live = true;
		loadTex().then(
			(render) => live && setTex(() => render),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [tex]);
	return useMemo(() => tex?.(source, display), [tex, source, display]);
}

/**
 * One formula, typeset by KaTeX. Until KaTeX has loaded, or if it cannot load, the source
 * shows as text. A wide display formula scrolls on its own instead of widening the reply.
 */
export const MathExpression = memo(function MathExpression({ value, display }: { value: string; display: "inline" | "block" }) {
	const html = useTex(value, display === "block");
	if (display === "block") {
		return html ? (
			<div data-slot="math-block" className="max-w-full overflow-x-auto overflow-y-hidden [&>.katex-display]:my-0" dangerouslySetInnerHTML={{ __html: html }} />
		) : (
			<div data-slot="math-block" className="whitespace-pre-wrap font-mono text-secondary">
				{value}
			</div>
		);
	}
	return html ? <span data-slot="math-inline" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="font-mono text-secondary">{value}</span>;
});

type BracketMathNode = MarkdownExtensionNode<"bracket-math", "math", { readonly value: string }, "block">;

/**
 * A \[…\] block at the offset, on lines of its own. Unclosed while a reply streams, it waits
 * for more text, so the source does not flash; unclosed in finished text, it stays text.
 */
const bracketBlock: MarkdownSyntaxContribution<BracketMathNode> = {
	startsWith: ["\\["],
	maxSpan: 8000,
	tokenize({ source, offset, end, isFinal }) {
		const close = source.indexOf("\\]", offset + 2);
		if (close === -1 || close + 2 > end) return isFinal || end < source.length ? { status: "no-match" } : { status: "defer" };
		const value = source.slice(offset + 2, close).trim();
		const lineEnd = source.indexOf("\n", close);
		if (!value || source.slice(close + 2, lineEnd === -1 ? end : lineEnd).trim()) return { status: "no-match" };
		return { status: "match", end: lineEnd === -1 ? end : lineEnd + 1, node: { type: "extension", plugin: "bracket-math", name: "math", display: "block", data: { value } } };
	},
};

/** Display maths written \[…\], which Astryx's $$…$$ does not read. Models write it often. */
export const bracketMathPlugin = createMarkdownPlugin<"bracket-math", BracketMathNode>({
	name: "bracket-math",
	apiVersion: 1,
	parseKey: "bracket-math@1",
	syntax: { block: [bracketBlock] },
	renderers: {
		math: {
			render: ({ node }) => <MathExpression value={node.data.value} display="block" />,
			toText: (node) => node.data.value,
		},
	},
});

// Code (a fence or a span), or \(…\) on one line.
const CODE_OR_INLINE_MATH = /(^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:\n {0,3}\2|(?![\s\S]))|(`+)[\s\S]*?\3)|\\\((.+?)\\\)/gm;

/**
 * \(…\) inline maths as $…$. A syntax plugin cannot read it: Markdown takes \( as an escaped
 * bracket before any plugin sees it. Code is left as it is.
 */
export function dollarInlineMath(text: string) {
	if (!text.includes("\\(")) return text;
	return text.replace(CODE_OR_INLINE_MATH, (match, code: string | undefined, _fence, _ticks, math: string | undefined) =>
		code !== undefined || !math?.trim() ? match : `$${math.trim()}$`,
	);
}
