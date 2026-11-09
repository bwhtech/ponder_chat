import DOMPurify from "dompurify";

/**
 * Slides are HTML that a reply wrote: one <section> per slide on a 1280×720 canvas.
 * The panel draws them in a sandboxed frame with no scripts, and a content policy that
 * loads nothing from other addresses, so a deck cannot run code or send data anywhere.
 */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
export const SLIDE_GAP = 32;

/** The policy goes first in the head, so nothing in the deck can loosen it. */
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

export function slideCount(html: string) {
	return html.match(/<section\b/gi)?.length ?? 0;
}

/** While a deck is written, only the slides that are finished: a half slide would jump about. */
export function finishedSlides(html: string) {
	const end = html.toLowerCase().lastIndexOf("</section>");
	return end === -1 ? "" : html.slice(0, end + "</section>".length);
}

/** The page for the panel's frame: the slides in a column, white on the panel's gray. */
export function framedDeck(html: string) {
	return page(html, FRAME_STYLE);
}

/** For present mode: the slides edge to edge, with no gap, so slide n starts at n × 720. */
export function presentedDeck(html: string) {
	return page(html, PRESENT_STYLE);
}

/** A file to download: the same slides, which print one to a page, as a PDF. */
export function standaloneDeck(html: string, title: string) {
	return page(html, FILE_STYLE, title);
}

function page(html: string, style: string, title = "Slides") {
	const body = DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_TAGS: ["style"] });
	return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<title>${escapeText(title)}</title>
<style>${BASE_STYLE}${style}</style>
</head><body>${body}</body></html>`;
}

function escapeText(text: string) {
	return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The default look. A deck's own <style> comes later in the page, so it wins. */
const BASE_STYLE = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #171717; -webkit-font-smoothing: antialiased; }
section {
	position: relative; display: flex; flex-direction: column; justify-content: center; gap: 28px;
	width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; padding: 72px 96px; overflow: hidden;
	background: #fff; font-size: 28px; line-height: 1.45;
}
h1, h2, h3, h4, p, ul, ol, table, blockquote, figure, pre { margin: 0; }
h1 { font-size: 68px; line-height: 1.08; font-weight: 700; letter-spacing: -0.025em; }
h2 { font-size: 48px; line-height: 1.12; font-weight: 650; letter-spacing: -0.02em; }
h3 { font-size: 34px; line-height: 1.2; font-weight: 600; letter-spacing: -0.01em; }
h1 + p, h2 + p { color: #525252; }
ul, ol { padding-left: 1.2em; display: flex; flex-direction: column; gap: 0.45em; }
li::marker { color: #a3a3a3; }
strong { font-weight: 650; }
a { color: inherit; }
blockquote { padding-left: 32px; border-left: 4px solid #e5e5e5; font-size: 36px; line-height: 1.35; }
table { border-collapse: collapse; font-size: 24px; }
th, td { padding: 12px 20px; border-bottom: 1px solid #e5e5e5; text-align: left; }
th { font-weight: 600; color: #404040; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; background: #f5f5f5; padding: 0.1em 0.3em; border-radius: 6px; }
pre { background: #f5f5f5; padding: 24px 28px; border-radius: 12px; font-size: 22px; line-height: 1.5; overflow: hidden; }
pre code { background: none; padding: 0; }
img, svg { max-width: 100%; max-height: 100%; }
`;

/** In the panel: the frame is exactly as wide as a slide; the panel scales it to fit. */
const FRAME_STYLE = `
html, body { background: transparent; overflow: hidden; }
body { display: flex; flex-direction: column; gap: ${SLIDE_GAP}px; }
section { flex-shrink: 0; border-radius: 12px; box-shadow: 0 0 0 2px rgb(0 0 0 / 0.06); }
`;

const PRESENT_STYLE = `
html, body { background: #000; overflow: hidden; }
`;

const FILE_STYLE = `
body { background: #f5f5f5; display: flex; flex-direction: column; align-items: center; gap: ${SLIDE_GAP}px; padding: ${SLIDE_GAP}px; }
section { flex-shrink: 0; border-radius: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.1); }
@page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
@media print {
	body { background: none; padding: 0; gap: 0; display: block; }
	section { border-radius: 0; box-shadow: none; break-after: page; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
`;
