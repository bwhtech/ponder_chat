import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import { marked, type TokenizerAndRendererExtension, type Token, type Tokens, type TokensList } from "marked";

export type MarkdownBlock = { key: string; kind: "html"; html: string } | { key: string; kind: "code"; code: string; language: string };

/** Turns markdown into blocks; fenced code becomes its own block so it can render as a CodeBlock. */
export class MarkdownRenderer {
	// Finished blocks never change while a reply streams, so cache their HTML by source.
	private cache = new Map<string, string>();

	render(markdown: string, repairIncomplete: boolean): MarkdownBlock[] {
		const source = repairIncomplete ? repairMarkdown(markdown) : markdown;
		// Options given here replace marked's defaults, where marked.use put the maths extensions.
		const tokens = marked.lexer(source, { ...marked.defaults, gfm: true });
		return tokens.filter((token) => token.type !== "space").map((token, index) => this.toBlock(token, index, tokens.links));
	}

	private toBlock(token: Token, index: number, links: TokensList["links"]): MarkdownBlock {
		if (token.type === "code") {
			const code = token as Tokens.Code;
			return { key: `${index}-code`, kind: "code", code: code.text, language: (code.lang ?? "").split(/\s/)[0] };
		}
		return { key: `${index}-${token.type}`, kind: "html", html: this.html(token, links) };
	}

	private html(token: Token, links: TokensList["links"]) {
		const cached = this.cache.get(token.raw);
		if (cached !== undefined) return cached;
		const list = Object.assign([token], { links }) as unknown as Parameters<typeof marked.parser>[0];
		const clean = DOMPurify.sanitize(marked.parser(list, { ...marked.defaults, gfm: true, breaks: true }), { ADD_ATTR: ["target"] });
		// A wide table scrolls on its own instead of widening the reply. Focusable so keyboards can scroll it.
		const html = token.type === "table" ? `<div data-slot="response-table" tabindex="0" role="region" aria-label="Table">${clean}</div>` : clean;
		if (this.cache.size > 500) this.cache.clear();
		this.cache.set(token.raw, html);
		return html;
	}
}

/**
 * Maths in LaTeX, in the four forms models write: $$…$$ and \[…\] for display, $…$ and \(…\)
 * inline. A single $ is maths only as Pandoc reads it: no space after the opening $, no space
 * before the closing $, and no digit after it. So "$5 and $10" stays money. Code is never maths:
 * code spans and blocks are read before these rules can see them.
 */
const blockMath: TokenizerAndRendererExtension = {
	name: "blockMath",
	level: "block",
	start: (src) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
	tokenizer(src) {
		const match = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
		if (match) return { type: "blockMath", raw: match[0], text: (match[1] ?? match[2]).trim() };
	},
	renderer: (token) => `<div data-slot="math-block">${tex(token.text, true)}</div>`,
};

const INLINE_MATH: [RegExp, boolean][] = [
	[/^\$\$((?:\\.|[^\\$])+?)\$\$/, true],
	[/^\\\[([\s\S]+?)\\\]/, true],
	[/^\\\(([\s\S]+?)\\\)/, false],
	[/^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/, false],
];

const inlineMath: TokenizerAndRendererExtension = {
	name: "inlineMath",
	level: "inline",
	// An escaped \$ is a dollar sign, not maths.
	start: (src) => src.match(/(?<!\\)\$|\\[([]/)?.index,
	tokenizer(src) {
		for (const [pattern, display] of INLINE_MATH) {
			const match = pattern.exec(src);
			if (match) return { type: "inlineMath", raw: match[0], text: match[1].trim(), display };
		}
	},
	renderer: (token) => tex(token.text, token.display),
};

marked.use({ extensions: [blockMath, inlineMath] });

/** KaTeX's HTML for the eye and MathML for screen readers. Maths that does not parse shows its source as plain text. */
function tex(source: string, displayMode: boolean) {
	return katex.renderToString(source, { displayMode, throwOnError: false, errorColor: "inherit", strict: "ignore", output: "htmlAndMathml" });
}

/**
 * Closes markdown that is still streaming, so half a reply renders like the
 * finished one: an open code fence, bold or inline code, and a link whose URL
 * has not arrived yet.
 */
export function repairMarkdown(text: string) {
	const fences = text.match(/^\s*(```|~~~)/gm)?.length ?? 0;
	if (fences % 2 === 1) return `${text}\n\`\`\``;

	// Display maths still being written waits until it is whole, rather than show its source.
	const lastBlock = text.slice(text.lastIndexOf("\n\n") + 1);
	const openDisplay = (lastBlock.match(/\$\$/g)?.length ?? 0) % 2 === 1 ? text.lastIndexOf("$$") : -1;
	const openBracket = text.lastIndexOf("\\[") > text.lastIndexOf("\\]") ? text.lastIndexOf("\\[") : -1;
	const cut = Math.max(openDisplay, openBracket);
	if (cut > text.length - lastBlock.length - 1) return repairMarkdown(text.slice(0, cut));

	let tail = "";
	const withoutCode = lastBlock.replace(/`[^`\n]*`/g, "");
	if ((withoutCode.match(/`/g)?.length ?? 0) % 2 === 1) tail += "`";
	if ((withoutCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) tail += "**";
	if ((withoutCode.match(/~~/g)?.length ?? 0) % 2 === 1) tail += "~~";
	return (text + tail).replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1");
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A" && node.getAttribute("href")?.match(/^https?:/)) {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noreferrer");
	}
});
