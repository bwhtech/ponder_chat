import { dayjs } from "frappe-ui";

/**
 * When something happened, written the same in the chat and /admin: "3 hours ago" within a
 * week, then a date such as "5 Nov", with the year when it is not this year.
 */
export function when(iso: string) {
	const time = dayjs(iso);
	if (dayjs().diff(time, "day") < 7) return time.fromNow();
	return time.format(time.year() === dayjs().year() ? "D MMM" : "D MMM YYYY");
}

/** A time still to come, such as "in 17 hours". */
export function fromNow(iso: string) {
	return dayjs(iso).fromNow();
}

/** A day on a chart axis, such as "5 Nov", from a UTC date such as "2026-11-05". */
export function shortDay(isoDate: string) {
	return dayjs(isoDate).format("D MMM");
}

/** A full date, such as "5 Nov 2026". */
export function fullDate(iso: string) {
	return dayjs(iso).format("D MMM YYYY");
}

/** A time of day, such as "5:30 AM". */
export function clockTime(iso: string) {
	return dayjs(iso).format("h:mm A");
}
