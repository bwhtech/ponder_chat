const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdExact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 });

/** A count grouped the same way everywhere, such as "10,000" or "47.3". */
export function count(value: number) {
	return grouped.format(value);
}

/** Credits: one decimal place under 100, whole numbers from 100 up, such as "47.3" or "1,000". */
export function credits(value: number) {
	return count(value >= 100 ? Math.round(value) : value);
}

/** US dollars, such as "$0.05". Amounts under a cent keep their digits, such as "$0.0004", not "$0.00". */
export function money(value: number) {
	return value > 0 && value < 0.01 ? usdExact.format(value) : usd.format(value);
}

/** An amount in any currency, such as "€12.50" or "$1,200". Whole amounts show no cents. An unknown code falls back to the number and the code. */
export function amount(value: number, currency = "USD") {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
	} catch {
		return `${count(value)} ${currency}`;
	}
}
