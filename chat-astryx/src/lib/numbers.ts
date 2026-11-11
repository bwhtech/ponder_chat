const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** A count grouped the same way everywhere, such as "10,000" or "47.3". */
export function count(value: number) {
	return grouped.format(value);
}

/** Credits: one decimal place under 100, whole numbers from 100 up, such as "47.3" or "1,000". */
export function credits(value: number) {
	return count(value >= 100 ? Math.round(value) : value);
}

/** A file's size, such as "512 B", "48 KB" or "2.3 MB". */
export function fileSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
