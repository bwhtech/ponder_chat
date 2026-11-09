import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * KaTeX's HTML for the eye and MathML for screen readers. Maths that does not parse shows
 * its source as plain text. Loaded on first use (MathExpression), with its stylesheet.
 */
export function tex(source: string, displayMode: boolean) {
	const html = katex.renderToString(source, { displayMode, throwOnError: false, errorColor: "inherit", strict: "ignore", output: "htmlAndMathml" });
	// The model writes the source. KaTeX does not trust commands such as \href by default;
	// sanitising the output as well keeps the Vue page's safety.
	return DOMPurify.sanitize(html);
}
