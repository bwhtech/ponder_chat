/**
 * CSV and TSV as a Markdown table, so the chunker splits them by rows and repeats the
 * header row in each passage. The first row is the header.
 */
export function delimitedToMarkdown(text: string, delimiter: "," | "\t") {
	const rows = parseDelimited(text, delimiter).filter((row) => row.some((cell) => cell.trim() !== ""));
	if (rows.length === 0) return "";
	// A loop, not Math.max(...rows): spread arguments overflow the stack at about 150,000 rows.
	let width = 0;
	for (const row of rows) width = Math.max(width, row.length);
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => cell(row[index] ?? "")).join(" | ")} |`;
	const [header, ...body] = rows;
	return [line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** RFC 4180: a quoted field can hold the delimiter, a line break and "" for a quote. */
export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const source = text.replace(/^﻿/, "");
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quoted) {
			if (char === '"' && source[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === delimiter) {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && source[index + 1] === "\n") index++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += char;
	}
	if (field !== "" || row.length > 0) rows.push([...row, field]);
	return rows;
}

/** A cell on one line, with no pipe that would end it. */
function cell(value: string) {
	return value.trim().replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}
