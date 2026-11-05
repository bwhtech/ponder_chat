import { dayjs } from "frappe-ui";
import { settings } from "../store";

const oneDecimal = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdExact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 });

/** Credits: one decimal place under 100, whole numbers above. */
export function credits(value: number) {
	return value >= 100 ? oneDecimal.format(Math.round(value)) : oneDecimal.format(value);
}

export function dollars(creditsUsed: number) {
	return usd.format(creditsUsed / settings.creditsPerUsd);
}

/** What one credit is worth, such as "$0.001". */
export function creditValue(perUsd: number) {
	return perUsd > 0 ? usdExact.format(1 / perUsd) : "—";
}

export function lastActive(iso: string | null) {
	return iso ? dayjs(iso).fromNow() : "Never";
}

export function date(iso: string | null) {
	return iso ? dayjs(iso).format("D MMM YYYY") : "—";
}

/** "5 Nov", from a UTC date such as "2026-11-05". */
export function shortDay(isoDate: string) {
	return dayjs(isoDate).format("D MMM");
}

/** Midnight UTC, when credits start again, in the viewer's time. */
export function resetTime() {
	return dayjs().utc().endOf("day").add(1, "millisecond").local().format("h:mm A");
}
