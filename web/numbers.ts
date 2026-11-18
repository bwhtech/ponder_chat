const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdSmall = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** A count grouped the same way everywhere, such as "10,000" or "47.3". */
export function count(value: number) {
	return grouped.format(value);
}

/** Credits: one decimal place under 100, whole numbers from 100 up, such as "47.3" or "1,000". */
export function credits(value: number) {
	return count(value >= 100 ? Math.round(value) : value);
}

/** US dollars, such as "$0.05". Under a cent, up to 4 decimals, such as "$0.0018", not "$0.00"; less than that is "<$0.0001". */
export function money(value: number) {
	if (value > 0 && value < 0.0001) return "<$0.0001";
	return value > 0 && value < 0.01 ? usdSmall.format(value) : usd.format(value);
}

/** An amount in any currency, such as "€12.50" or "$1,200". Whole amounts show no cents. An unknown code falls back to the number and the code. */
export function amount(value: number, currency = "USD") {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
	} catch {
		return `${count(value)} ${currency}`;
	}
}
