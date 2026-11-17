/**
 * Cuts text into pieces of at most `limit` characters: at line breaks, then at sentence
 * ends, then at spaces, and a word longer than the limit at the limit. The pieces are of
 * about the same size, so a paragraph of 1,100 characters gives two of 550, not one of
 * 1,000 and a scrap of 100.
 */
export function splitText(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const even = Math.ceil(text.length / Math.ceil(text.length / limit));
	for (const separator of ["\n", /(?<=[.!?;:])\s+/, " "]) {
		const parts = text.split(separator);
		if (parts.length > 1) return pack(parts, typeof separator === "string" ? separator : " ", even, limit).flatMap((piece) => splitText(piece, limit));
	}
	return Array.from({ length: Math.ceil(text.length / limit) }, (_, index) => text.slice(index * limit, (index + 1) * limit));
}

/** Joins parts while they stay within `even`, or within `limit` while the piece is still short. */
function pack(parts: string[], joiner: string, even: number, limit: number) {
	const packed: string[] = [];
	let current = "";
	for (const part of parts) {
		const joined = current ? current + joiner + part : part;
		if (joined.length <= even || (current.length < even / 2 && joined.length <= limit)) current = joined;
		else {
			if (current) packed.push(current);
			current = part;
		}
	}
	if (current) packed.push(current);
	return packed;
}
