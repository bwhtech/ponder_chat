import { ARTIFACT_CDNS } from "../../shared/cdns";

/**
 * An HTML artifact is one web page that a reply wrote: its HTML, CSS and JavaScript in one
 * file. The panel runs it in a sandboxed frame with no `allow-same-origin`, so the page has
 * an origin of its own and cannot reach Ponder's cookies, storage or API.
 *
 * A content policy goes first in the page. Scripts, styles and fonts load only from the
 * public CDNs below, and the page can send nothing to other addresses: no images, no
 * fetch, no forms. A policy that the page adds itself can only make this one stricter.
 *
 * This policy cannot stop the page from sending its own frame to another address, by
 * script or by a meta refresh. The policy of the page that holds the frame stops that:
 * `frame-src 'none'` in server/app.ts.
 */
const CDNS = ARTIFACT_CDNS.join(" ");
const TAILWIND = "https://cdn.tailwindcss.com";
const GOOGLE_FONTS = { css: "https://fonts.googleapis.com", files: "https://fonts.gstatic.com" };

const POLICY = [
	"default-src 'none'",
	`script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS} ${TAILWIND}`,
	`style-src 'unsafe-inline' ${CDNS} ${GOOGLE_FONTS.css}`,
	`font-src data: ${CDNS} ${GOOGLE_FONTS.files}`,
	`img-src data: blob: ${CDNS}`,
	"media-src data: blob:",
	// Libraries load their own data and modules from the CDNs, such as a map's shapes.
	`connect-src ${CDNS}`,
	"worker-src blob:",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

/** Scripts on, forms on (their submit handlers run; form-action stops a real submit). No same origin, popups or top navigation. */
export const HTML_SANDBOX = "allow-scripts allow-forms";

/** The page for the frame: the artifact with the policy put first, after a doctype so the page keeps standards mode. */
export function framedPage(html: string) {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
	const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0];
	return doctype ? `${doctype}${meta}${html.slice(doctype.length)}` : `<!doctype html>${meta}${html}`;
}
