/**
 * Admin alerts and Ponder's email, against a fake ntfy and a fake Cloudflare: an
 * HttpClient that answers in the test. The log lines are the ones the old code printed.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PonderConfig from "../config.ts";
import * as Mailer from "../email/Mailer.ts";
import * as Notify from "./Notify.ts";

type Sent = { method: string; url: string; headers: Record<string, string>; body: string };

/** A fake server that answers every request with `status`, and the log lines. */
function fakes(env: Record<string, string>, status = 200) {
	const sent: Sent[] = [];
	const lines: string[] = [];
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) =>
		Effect.sync(() => {
			const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
			sent.push({ method: request.method, url: url.href, headers: { ...request.headers }, body });
			return HttpClientResponse.fromWeb(request, new Response("{}", { status }));
		}),
	);
	const logger = Logger.make(({ message }) => lines.push((Array.isArray(message) ? message : [message]).join(" ")));
	const layer = Layer.mergeAll(Notify.layer, Mailer.layer).pipe(
		Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), PonderConfig.layerFromEnv(env))),
		Layer.provideMerge(Logger.layer([logger])),
	);
	return { sent, lines, layer };
}

describe("Notify", () => {
	it.effect("posts the alert to the ntfy topic, with its title and link", () => {
		const fake = fakes({ NOTIFY_URL: "https://ntfy.example/ponder-alerts" });
		return Effect.gen(function* () {
			yield* Notify.Notify.use((notify) => notify.admins("Ponder Chat: credit request", "Ada asked for more credits.", "https://chat.example/admin/requests"));
			assert.strictEqual(fake.sent.length, 1);
			const [alert] = fake.sent;
			assert.strictEqual(alert!.method, "POST");
			assert.strictEqual(alert!.url, "https://ntfy.example/ponder-alerts");
			assert.deepInclude(alert!.headers, { title: "Ponder Chat: credit request", tags: "ponder-chat", click: "https://chat.example/admin/requests" });
			assert.strictEqual(alert!.body, "Ada asked for more credits.");
			assert.deepStrictEqual(fake.lines, []);
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("logs the alert without NOTIFY_URL, and a refusal without failing", () =>
		Effect.gen(function* () {
			const none = fakes({});
			yield* Notify.Notify.use((notify) => notify.admins("Title", "Message")).pipe(Effect.provide(none.layer));
			assert.deepStrictEqual(none.lines, ["notify (no NOTIFY_URL): Title: Message"]);
			assert.deepStrictEqual(none.sent, []);
			const refused = fakes({ NOTIFY_URL: "https://ntfy.example/topic" }, 500);
			yield* Notify.Notify.use((notify) => notify.admins("Title", "Message")).pipe(Effect.provide(refused.layer));
			assert.deepStrictEqual(refused.lines, ["notify: ntfy answered 500"]);
		}),
	);
});

describe("Mailer", () => {
	const email = Mailer.inviteEmail("ada@example.org", "https://chat.example");
	const sender = { PONDER_EMAIL_FROM: "Ponder <chat@example.org>", CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_EMAIL_TOKEN: "cf-token", CLOUDFLARE_API_URL: "http://fake.test/client/v4/" };

	it.effect("sends through Cloudflare's API, from the sender set up", () => {
		const fake = fakes(sender);
		return Effect.gen(function* () {
			yield* Mailer.Mailer.use((mailer) => mailer.send(email));
			const [sent] = fake.sent;
			assert.strictEqual(sent!.url, "http://fake.test/client/v4/accounts/acc123/email/sending/send");
			assert.deepInclude(sent!.headers, { authorization: "Bearer cf-token", "content-type": "application/json" });
			assert.deepStrictEqual(JSON.parse(sent!.body), { from: "Ponder <chat@example.org>", ...email });
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("fails with Cloudflare's status, not its answer", () => {
		const fake = fakes(sender, 422);
		return Effect.gen(function* () {
			const error = yield* Effect.flip(Mailer.Mailer.use((mailer) => mailer.send(email)));
			assert.strictEqual(error._tag, "EmailNotSent");
			assert.strictEqual(error.status, 422);
			assert.strictEqual(error.message, "The email could not be sent (422).");
		}).pipe(Effect.provide(fake.layer));
	});

	it.effect("prints the email to the log when no sender is set up", () => {
		const fake = fakes({});
		return Effect.gen(function* () {
			yield* Mailer.Mailer.use((mailer) => mailer.send({ to: "ada@example.org", subject: "123456 is your OTP for Ponder Chat.", text: "Your code", html: "" }));
			assert.deepStrictEqual(fake.lines, ["email (not sent, no sender set up) to ada@example.org: 123456 is your OTP for Ponder Chat.\nYour code"]);
			assert.deepStrictEqual(fake.sent, []);
		}).pipe(Effect.provide(fake.layer));
	});
});
