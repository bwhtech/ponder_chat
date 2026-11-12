import { dayjs } from "frappe-ui";
import { clockTime, fullDate, when } from "../../dates";
import { money } from "../../numbers";
import { settings } from "../store";

export { credits, money } from "../../numbers";

/** US dollars for a credit count, at the saved credit value. */
export function dollars(creditsUsed: number) {
	return money(creditsUsed / settings.creditsPerUsd);
}

/** What one credit is worth, such as "$0.001". */
export function creditValue(perUsd: number) {
	return perUsd > 0 ? money(1 / perUsd) : "—";
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
