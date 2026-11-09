// A copy of shared/thread-name.ts: Vite would read the root tsconfig (frappe-ui's) to import it from there.
// The two must stay the same, as the server names untitled threads with the same rule.
/**
 * The name of a thread with no title: the first line of its first message, cut at a word
 * near 60 characters. The server names it so in the list (server/db.ts), and the page
 * names a new thread so before the list has it (web/threads.ts), so the two must match.
 */
export function nameFromFirstMessage(text: string | null | undefined) {
	const line = (text ?? "").split("\n")[0].trim();
	if (!line) return "New chat";
	if (line.length <= 60) return line;
	const cut = line.slice(0, 60);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}
