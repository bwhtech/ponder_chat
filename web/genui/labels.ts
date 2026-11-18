/**
 * What a card is called in its loading and failure lines: its title in curly quotes, as
 * other steps quote names, or "a chart or table" before the title has arrived.
 */
export function cardSubject(title: string | undefined) {
	return title?.trim() ? `“${title.trim()}”` : "a chart or table";
}
