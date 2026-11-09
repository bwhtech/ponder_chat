/**
 * Reads CSV or TSV text into rows (RFC 4180): quoted fields may hold the delimiter,
 * line breaks and doubled quotes. Stops after `limit` rows and says how many it skipped.
 */
export type ParsedTable = { rows: string[][]; more: number };

export function parseDelimited(text: string, delimiter: "," | "\t", limit: number): ParsedTable {
	const rows: string[][] = [];
	let more = 0;
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	const endRow = () => {
		row.push(field);
		field = "";
		// A blank line is no row.
		if (row.length > 1 || row[0] !== "") {
			if (rows.length < limit) rows.push(row);
			else more++;
		}
		row = [];
	};

	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (quoted) {
			if (char !== '"') field += char;
			else if (source[index + 1] === '"') (field += '"'), index++;
			else quoted = false;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === delimiter) row.push(field), (field = "");
		else if (char === "\n") endRow();
		else if (char !== "\r") field += char;
	}
	if (field !== "" || row.length) endRow();
	return { rows, more };
}

export function delimiterFor(name: string, mediaType: string): "," | "\t" {
	return /\.tsv$/i.test(name) || mediaType === "text/tab-separated-values" ? "\t" : ",";
}

/** A column of numbers reads better aligned to the right. */
export function isNumericColumn(rows: string[][], column: number) {
	let numbers = 0;
	for (const row of rows) {
		const value = row[column]?.trim() ?? "";
		if (!value) continue;
		if (!/^[-+]?[$€£₹]?[\d,]*\.?\d+%?$/.test(value)) return false;
		numbers++;
	}
	return numbers > 0;
}
