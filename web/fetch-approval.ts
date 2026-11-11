import type { UIMessage } from "ai";

/**
 * The question on the card when web_fetch waits for the person: a page that they did not
 * give and no search found (server/search/trusted-pages.ts). The address is what the
 * person must judge, since data can leave in it, so the question shows it in full. The
 * card itself hides inputs longer than 60 characters, and a tool label gets only the
 * tool's name, so the address comes from the call that waits in the last message.
 */
const MAX_SHOWN = 300;
const WHY = "You did not give this address, and no search found it.";

export function fetchApprovalQuestion(messages: UIMessage[]): string {
	const waiting = (messages.at(-1)?.parts ?? []).flatMap((part) => {
		if (part.type !== "tool-web_fetch" || !("state" in part) || part.state !== "approval-requested") return [];
		const url = (part.input as { url?: unknown } | undefined)?.url;
		return typeof url === "string" ? [url] : [];
	});
	// With two pages waiting, both cards would show one address: name neither.
	if (waiting.length !== 1) return `Allow Ponder to read this page? ${WHY} Show details has its address.`;
	const url = waiting[0]!;
	return `Allow Ponder to read ${url.length > MAX_SHOWN ? `${url.slice(0, MAX_SHOWN)}…` : url}? ${WHY}`;
}
