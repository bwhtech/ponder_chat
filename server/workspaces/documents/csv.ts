import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * CSV and TSV as a Markdown table, so the chunker splits them by rows and repeats the
 * header row in each passage. The first row is the header.
 *
 * Every row is padded to the widest one. A wide header over many short rows would grow a
 * few kilobytes into gigabytes, on the server's one thread, so the size of the table is
 * worked out before it is built, and a table that is too large is refused.
 */
/** More columns than a person can read in a passage of about 1,000 characters. */
export const MAX_COLUMNS = 500;
/** The table's Markdown at most: twice the upload limit, as a 10 MB CSV of short numbers grows to about that. */
export const MAX_TABLE_CHARS = 20_000_000;

/** The table would be too wide, or too large once every row is padded. */
export class TableTooLarge extends Schema.TaggedError<TableTooLarge>()("TableTooLarge", {
	reason: Schema.Literals(["columns", "size"]),
}) {
	override get message() {
		return this.reason === "columns"
			? `This table is too wide. It can have at most ${MAX_COLUMNS} columns.`
			: "This table is too large once its rows are filled out. Remove empty columns, or split it into smaller files.";
	}
}

export function delimitedToMarkdown(text: string, delimiter: "," | "\t"): Result.Result<string, TableTooLarge> {
	const rows = parseDelimited(text, delimiter).filter((row) => row.some((cell) => cell.trim() !== ""));
	if (rows.length === 0) return Result.succeed("");
	// A loop, not Math.max(...rows): spread arguments overflow the stack at about 150,000 rows.
	let width = 0;
	for (const row of rows) width = Math.max(width, row.length);
	if (width > MAX_COLUMNS) return Result.fail(new TableTooLarge({ reason: "columns" }));
	const cells = rows.map((row) => row.map(cell));
	if (tableChars(cells, width) > MAX_TABLE_CHARS) return Result.fail(new TableTooLarge({ reason: "size" }));
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
	const [header, ...body] = cells;
	return Result.succeed([line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n"));
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

/**
 * The length of the table's Markdown, with every row padded to `width` and the line under
 * the header: "| a | b |" is 3 characters for each cell and 1 more, plus the cells' text.
 */
function tableChars(rows: ReadonlyArray<ReadonlyArray<string>>, width: number) {
	let chars = (rows.length + 1) * (3 * width + 2) + 3 * width;
	for (const row of rows) for (const value of row) chars += value.length;
	return chars;
}

/** A cell on one line, with no pipe that would end it. */
function cell(value: string) {
	return value.trim().replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}
