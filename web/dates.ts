/**
 * Dates as the chat and /admin write them. These were dayjs calls; frappe-ui's dayjs comes
 * with nine plugins (time zones, parsing), about 30 KB that the first page loaded for one
 * "Refills in 7 hours". The words and thresholds are dayjs's own (its relativeTime plugin),
 * so nothing reads differently.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// dayjs counts months and years on the calendar. Only times further than 26 days reach
// them, and the app shows those as dates (when), so an average length is close enough.
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/**
 * dayjs's relativeTime steps: a step with a unit measures the time again in that unit,
 * rounded, and a step holds while that number is at most `max`.
 */
const STEPS: { words: string; max?: number; unit?: number }[] = [
	{ words: "a few seconds", max: 44, unit: SECOND },
	{ words: "a minute", max: 89 },
	{ words: "%d minutes", max: 44, unit: MINUTE },
	{ words: "an hour", max: 89 },
	{ words: "%d hours", max: 21, unit: HOUR },
	{ words: "a day", max: 35 },
	{ words: "%d days", max: 25, unit: DAY },
	{ words: "a month", max: 45 },
	{ words: "%d months", max: 10, unit: MONTH },
	{ words: "a year", max: 17 },
	{ words: "%d years", unit: YEAR },
];

/**
 * When something happened, written the same in the chat and /admin: "3 hours ago" within a
 * week, then a date such as "5 Nov", with the year when it is not this year.
 */
export function when(iso: string) {
	const time = parse(iso);
	const now = new Date();
	if (wholeDaysBetween(time, now) < 7) return relative(time, now);
	return time.getFullYear() === now.getFullYear() ? dayAndMonth(time) : fullDate(iso);
}

/** A time still to come, such as "in 17 hours". */
export function fromNow(iso: string) {
	return relative(parse(iso), new Date());
}

/** A day on a chart axis, such as "5 Nov", from a UTC date such as "2026-11-05". */
export function shortDay(isoDate: string) {
	return dayAndMonth(parse(isoDate));
}

/** A full date, such as "5 Nov 2026". */
export function fullDate(iso: string) {
	const time = parse(iso);
	return `${dayAndMonth(time)} ${time.getFullYear()}`;
}

/** A time of day, such as "5:30 AM". */
export function clockTime(iso: string) {
	const time = parse(iso);
	const hours = time.getHours();
	return `${hours % 12 || 12}:${String(time.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

/** A date alone ("2026-11-05") is that day here, as dayjs reads it; Date would read midnight UTC. */
function parse(iso: string) {
	const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(iso);
}

function dayAndMonth(time: Date) {
	return `${time.getDate()} ${MONTHS[time.getMonth()]}`;
}

/** dayjs's diff in days: whole days, with a change of clock time (summer time) taken out. */
function wholeDaysBetween(from: Date, to: Date) {
	const clockShift = (to.getTimezoneOffset() - from.getTimezoneOffset()) * MINUTE;
	return Math.trunc((to.getTime() - from.getTime() - clockShift) / DAY);
}

/** "in 17 hours" or "3 hours ago", as dayjs's fromNow writes it. */
function relative(time: Date, now: Date) {
	const ms = time.getTime() - now.getTime();
	let amount = ms / SECOND;
	let words = STEPS[0]!.words;
	for (const [index, step] of STEPS.entries()) {
		if (step.unit) amount = ms / step.unit;
		const rounded = Math.round(Math.abs(amount));
		if (step.max === undefined || rounded <= step.max) {
			// "1 minutes" reads "a minute", and so on: the step before says it in words.
			words = (rounded <= 1 && index > 0 ? STEPS[index - 1]! : step).words.replace("%d", String(rounded));
			break;
		}
	}
	return ms > 0 ? `in ${words}` : `${words} ago`;
}
