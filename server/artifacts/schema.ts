import { tool } from "ai";
import { z } from "zod";

/**
 * write_artifact: a document, a slide deck or a web page that the person sees in the side panel.
 * The content is the tool call's input, so it is saved with the message and needs no
 * table of its own. Writing the same id again makes a new version; each call keeps its own.
 * The browser draws the call (web/artifacts/), and the model gets a short receipt back.
 */
export const WRITE_ARTIFACT = "write_artifact";

export const writeArtifactInput = z.object({
	id: z
		.string()
		.regex(/^[a-z0-9-]{1,48}$/)
		.describe("A short kebab-case name for this artifact, like q3-report. Use the same id to write a new version of an artifact."),
	kind: z
		.enum(["document", "slides", "html"])
		.describe("document: Markdown. slides: HTML, one <section> per slide. html: one web page, with its CSS and JavaScript in the same file."),
	title: z.string().min(1).max(120).describe("The title the person sees, like Q3 sales report."),
	content: z.string().describe("The whole artifact. For a new version, the whole new version, not a change."),
});

export type WriteArtifactInput = z.infer<typeof writeArtifactInput>;

const DESCRIPTION =
	"Write a document, a slide deck or a web page that opens in a panel beside the chat, where the person can read, use, copy and download it. " +
	"Use it when the person asks for something to keep, send or present: a report, a letter, a plan, a proposal, notes, a slide deck. " +
	"Use a web page for something to see or use: an interactive chart, a dashboard, a calculator, a small tool or game, a mock-up of a page. " +
	"Not for short answers, explanations or code snippets: answer those in the chat. " +
	"To change an artifact, write it again with the same id and the whole new content.";

export const ARTIFACT_GUIDANCE = `You can write artifacts with ${WRITE_ARTIFACT}: a document, a slide deck or a web page that opens in a panel beside the chat. Use one when the person asks for something to keep, send or present. When they ask for a file in a set format, such as a Word or Excel file, make that file with run_python instead. After you write one, say in a sentence or two what it holds; do not repeat its content in the chat.

A document is Markdown: headings, lists, tables, code blocks, and maths in LaTeX ($...$ and $$...$$).

Slides are HTML: one <section> per slide, each drawn on a 1280×720 canvas. Plain <h1>, <h2>, <p>, <ul>, <ol>, <table>, <blockquote> and <img> look good with the default style: a title slide with an <h1> and a <p>, then one idea per slide, with a heading and a few short points. For a deck-wide look, add one <style> element first; for a slide's own layout, use a class or a style attribute on its <section>. Inline SVG works for diagrams and simple charts. Scripts do not run, and images, fonts and styles from other addresses do not load: use inline SVG or data: URLs. Keep text large and short, and never let a slide's content run past its canvas.

A web page (kind html) is one complete HTML file, with its CSS in <style> and its JavaScript in <script>. It runs in a sandboxed frame that fills the panel, so make it fit any width. Scripts, styles and fonts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com and Google Fonts, for example Chart.js, D3, Three.js or the Tailwind CDN. Nothing else on the internet loads: no fetch to APIs, and no images from other addresses, so put data in the page and draw images with SVG, canvas or data: URLs. localStorage, sessionStorage, cookies, alert(), confirm() and new windows do not work, so keep state in variables and show messages in the page.`;

/** The tool for the chat workflow. Writing needs nothing on the server, so it is no step. */
export function artifactTools() {
	return {
		[WRITE_ARTIFACT]: tool({
			description: DESCRIPTION,
			inputSchema: writeArtifactInput,
			execute: async ({ id, kind, title }) => ({ ok: true, id, kind, title, shown: "The person sees it in the side panel." }),
		}),
	};
}
