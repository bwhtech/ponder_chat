import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

/**
 * Effect's logs, written as Ponder's console lines always were: `Effect.logError("x:", y)`
 * prints what `console.error("x:", y)` printed, and logWarning goes to console.warn,
 * logInfo and log to console.log. No date, level or fiber prefix: the journal adds the
 * time, and deploy/sentinel.sh looks for the lines as they are.
 *
 * The console is looked up on each line, not kept: logs.ts replaces console.error and
 * console.warn when tracing is on, to end each line inside a trace with its trace id.
 * Inside an Effect span the active OpenTelemetry span is that span (Tracing.ts), so the
 * trace id is the one of the span the log is in.
 *
 * A Cause passed to a log (`Effect.logError("x:", cause)`) is printed pretty, after the message.
 */
export const logger = Logger.make(({ logLevel, message, cause }) => {
	// One value, or an array of them: `[message].flat()` spreads an array and keeps one value.
	const parts: unknown[] = [message].flat();
	if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
	switch (logLevel) {
		case "Fatal":
		case "Error":
			return console.error(...parts);
		case "Warn":
			return console.warn(...parts);
		case "Debug":
		case "Trace":
			return console.debug(...parts);
		default:
			return console.log(...parts);
	}
});

/** Replaces Effect's default logger. */
export const layer = Logger.layer([logger]);
