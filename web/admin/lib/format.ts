import { dayjs } from "frappe-ui";
import { clockTime, fullDate, when } from "../../dates";
import { settings } from "../store";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdExact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 });

export { credits } from "../../numbers";

/** US dollars, such as "$0.05". Amounts under a cent keep their digits, such as "$0.0004", not "$0.00". */
export function money(value: number) {
	return value > 0 && value < 0.01 ? usdExact.format(value) : usd.format(value);
}

/** US dollars for a credit count. */
export function dollars(creditsUsed: number) {
	return money(creditsUsed / settings.creditsPerUsd);
}

/** What one credit is worth, such as "$0.001". */
export function creditValue(perUsd: number) {
	return perUsd > 0 ? usdExact.format(1 / perUsd) : "—";
}

export function lastActive(iso: string | null) {
	return iso ? when(iso) : "Never";
}

export function date(iso: string | null) {
	return iso ? fullDate(iso) : "—";
}

/** Midnight UTC, when credits start again, in the viewer's time. */
export function resetTime() {
	return clockTime(dayjs().utc().endOf("day").add(1, "millisecond").toISOString());
}
