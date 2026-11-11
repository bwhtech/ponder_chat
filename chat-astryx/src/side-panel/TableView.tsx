import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { proportional, Table, useTableRowIndex, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useMemo, useState } from "react";
import { delimiterFor, isNumericColumn, parseDelimited, type ParsedTable } from "./csv";
import NotShown from "./NotShown";

/**
 * A CSV or TSV file as a table: the first row is the header and stays in view while
 * the rest scrolls. Plain values only: no formulas, sorting or editing.
 */
type Props = { url: string; name: string; mediaType: string; onRows: (count: number) => void };
type Row = Record<string, string>;

/** More rows than this make the page slow; the file can still be downloaded whole. */
const ROW_LIMIT = 2_000;

export default function TableView({ url, name, mediaType, onRows }: Props) {
	const [table, setTable] = useState<ParsedTable | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let stale = false;
		void (async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) throw new Error(String(response.status));
				const parsed = parseDelimited(await response.text(), delimiterFor(name, mediaType), ROW_LIMIT + 1);
				if (stale) return;
				setTable(parsed);
				onRows(Math.max(0, parsed.rows.length - 1) + parsed.more);
			} catch {
				if (!stale) setFailed(true);
			}
		})();
		return () => {
			stale = true;
		};
	}, [url, name, mediaType, onRows]);

	if (failed) return <NotShown title="This file could not be shown." url={url} name={name} />;
	if (!table)
		return (
			<div className="flex flex-col gap-2 p-4">
				{Array.from({ length: 8 }, (_, line) => (
					<Skeleton key={line} height={24} index={line} />
				))}
			</div>
		);
	if (!table.rows.length)
		return (
			<div className="flex justify-center px-6 pt-[20vh]">
				<EmptyState title="This file is empty." />
			</div>
		);
	return <Rows table={table} />;
}

/** The first row names the columns; a column of numbers aligns to the right. */
function tableShape(table: ParsedTable) {
	const header = table.rows[0] ?? [];
	const body = table.rows.slice(1);
	const width = Math.max(0, ...table.rows.map((row) => row.length));
	const sample = body.slice(0, 200);
	const columns: TableColumn<Row>[] = Array.from({ length: width }, (_, column) => ({
		key: `c${column}`,
		header: header[column] ?? "",
		align: isNumericColumn(sample, column) ? "end" : "start",
		width: proportional(1, { minWidth: 120 }),
	}));
	const data = body.map((row) => Object.fromEntries(row.map((value, column) => [`c${column}`, value])) as Row);
	return { body, columns, data };
}

function Rows({ table }: { table: ParsedTable }) {
	const { body, columns, data } = useMemo(() => tableShape(table), [table]);
	const rowIndex = useTableRowIndex({ data });

	return (
		// The table's own scroll region fills the panel and scrolls both ways, so its header stays in view.
		<div className="flex h-full min-h-0 flex-col [&>.astryx-table-scroll-wrapper]:min-h-0 [&>.astryx-table-scroll-wrapper]:flex-1 [&>.astryx-table-scroll-wrapper]:overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-surface">
			<Table data={data} columns={columns} plugins={{ rowIndex }} density="compact" dividers="grid" textOverflow="truncate" hasHover />
			{table.more > 0 && (
				<div className="px-4 py-3">
					<Text type="supporting">
						Showing the first {body.length.toLocaleString()} rows of {(body.length + table.more).toLocaleString()}. Download the file to see them all.
					</Text>
				</div>
			)}
		</div>
	);
}
