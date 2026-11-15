import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PonderConfig from "../config.ts";
import { requestProblem } from "../runtime/Http.ts";

/**
 * Alerts for the admins' phones: a short message to NOTIFY_URL, an ntfy topic (the same
 * one deploy/sentinel.sh sends to). Without NOTIFY_URL, the message goes to the log.
 * Anyone who knows the topic can read it, so a message never holds chat content.
 */
export class Notify extends Context.Service<
	Notify,
	{
		/** Sends the alert. A failure is logged, never returned: an alert must not fail what it tells about. */
		readonly admins: (title: string, message: string, click?: string) => Effect.Effect<void>;
	}
>()("ponder/notify/Notify") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const client = yield* HttpClient.HttpClient;

	const admins = Effect.fn("Notify.admins")(function* (title: string, message: string, click?: string) {
		if (Option.isNone(config.notifyUrl)) return yield* Effect.log(`notify (no NOTIFY_URL): ${title}: ${message}`);
		const request = HttpClientRequest.post(Redacted.value(config.notifyUrl.value)).pipe(
			HttpClientRequest.setHeaders({ Title: title, Tags: "ponder-chat", ...(click && { Click: click }) }),
			HttpClientRequest.bodyText(message),
		);
		yield* client.execute(request).pipe(
			Effect.timeout("10 seconds"),
			Effect.flatMap((response) => (response.status >= 200 && response.status < 300 ? Effect.void : Effect.logError(`notify: ntfy answered ${response.status}`))),
			Effect.catch((error) => Effect.logError("notify:", requestProblem(error))),
		);
	});

	return Notify.of({ admins });
});

export const layer = Layer.effect(Notify, make);
