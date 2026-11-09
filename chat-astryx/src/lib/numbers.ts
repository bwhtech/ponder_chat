const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** A count grouped the same way everywhere, such as "10,000" or "47.3". */
export function count(value: number) {
	return grouped.format(value);
}

/** Credits: one decimal place under 100, whole numbers from 100 up, such as "47.3" or "1,000". */
export function credits(value: number) {
	return count(value >= 100 ? Math.round(value) : value);
}
