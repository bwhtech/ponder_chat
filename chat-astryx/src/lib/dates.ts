/**
 * When something happened, written the same everywhere: "3 hours ago" within a week,
 * then a date such as "5 Nov", with the year when it is not this year.
 */
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 24 * 3600],
	["month", 30 * 24 * 3600],
	["week", 7 * 24 * 3600],
	["day", 24 * 3600],
	["hour", 3600],
	["minute", 60],
];

export function when(iso: string) {
	const time = new Date(iso);
	const days = (Date.now() - time.getTime()) / 86_400_000;
	if (days < 7) return fromNow(iso);
	const sameYear = time.getFullYear() === new Date().getFullYear();
	return time.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** "in 17 hours", "3 minutes ago", "just now". */
export function fromNow(iso: string) {
	const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return seconds > 0 ? "in a few seconds" : "just now";
}

/** A full date, such as "5 Nov 2026". */
export function fullDate(iso: string) {
	return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A time of day, such as "5:30 AM". */
export function clockTime(iso: string) {
	return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
