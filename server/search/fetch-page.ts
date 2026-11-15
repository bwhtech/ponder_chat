import { Readability } from "@mozilla/readability";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseHTML } from "linkedom";
import { isIP } from "node:net";
import { fetch, type Response } from "undici";
import * as NetGuard from "../net/NetGuard.ts";
import { withPeer } from "../tracing/http.ts";

/**
 * web_fetch: reads a page on our own server, so no other company sees what is read.
 * The model picks the address, so a page must not reach this machine, the tailnet or
 * any private network (net/NetGuard.ts), checked again on every redirect.
 */
const MAX_BYTES = 3_000_000;
const MAX_CHARS = 20_000;
const MAX_REDIRECTS = 5;
/** For each request, with the reading of the last one's body, as AbortSignal.timeout gave each fetch. */
const TIMEOUT = "20 seconds";
const USER_AGENT = "PonderChat/1.0 (+https://chat.bwh.tech)";
const HTML = /^(text\/html|application\/xhtml\+xml)/;
const TEXT = /^(text\/(plain|markdown|csv)|application\/json)/;

export type FetchedPage = { url: string; title: string; text: string; truncated: boolean };

/** An address web_fetch does not read, or a page that did not answer with one. Fixed text: never the address. */
export class PageRefused extends Schema.TaggedError<PageRefused>()("PageRefused", {
	reason: Schema.Literals(["invalid", "scheme", "port", "credentials", "private", "redirects", "status"]),
	status: Schema.optional(Schema.Number),
}) {
	override get message() {
		switch (this.reason) {
			case "invalid":
				return "Invalid URL";
			case "scheme":
				return "Only http and https addresses can be read.";
			case "port":
				return "Only the usual web ports (80 and 443) can be read.";
			case "credentials":
				return "Addresses with a user name or password cannot be read.";
			case "private":
				return "That address is on a private network.";
			case "redirects":
				return "The page redirects too many times.";
			case "status":
				return `The page answered ${this.status}.`;
		}
	}
}

/**
 * The request failed: undici's error is the cause (its own cause names the reason, such
 * as a name that resolves to a private address), or it took too long.
 */
export class PageUnreachable extends Schema.TaggedError<PageUnreachable>()("PageUnreachable", {
	timedOut: Schema.Boolean,
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		return this.timedOut ? "The page took too long to answer." : "The page could not be reached.";
	}
}

type Agent = NetGuard.NetGuard["Service"]["publicAgent"];
type Hop = { _tag: "Redirect"; location: string } | { _tag: "Page"; page: FetchedPage };

/** The page's title and readable text, cut to MAX_CHARS. No span of its own: web_fetch.read (tool.ts) is its span. */
export const fetchPage = Effect.fnUntraced(function* (address: string) {
	const { publicAgent } = yield* NetGuard.NetGuard;
	let url = yield* checkedUrl(address);
	for (let redirects = 0; ; redirects++) {
		const hop = yield* request(url, publicAgent, address);
		if (hop._tag === "Page") return hop.page;
		if (redirects >= MAX_REDIRECTS) return yield* new PageRefused({ reason: "redirects" });
		// A Location that does not parse is refused by checkedUrl, as an invalid address.
		url = yield* checkedUrl(URL.parse(hop.location, url)?.href ?? hop.location);
	}
});

/** One request, in its own time: a redirect to follow, or the page read to its end. */
const request = (url: URL, agent: Agent, address: string) =>
	Effect.tryPromise({
		// Its request spans say "web", and nothing of the address (tracing/http.ts).
		try: (signal) => withPeer("web", () => hop(url, agent, address, signal)),
		catch: (cause) => new PageUnreachable({ timedOut: false, cause }),
	}).pipe(
		Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new PageUnreachable({ timedOut: true })) }),
		Effect.flatMap((answer) => (answer instanceof PageRefused ? Effect.fail(answer) : Effect.succeed(answer))),
	);

async function hop(url: URL, agent: Agent, address: string, signal: AbortSignal): Promise<Hop | PageRefused> {
	const response = await fetch(url, {
		dispatcher: agent,
		redirect: "manual",
		signal,
		headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
	});
	const location = response.headers.get("location");
	if (response.status >= 300 && response.status < 400 && location) {
		await response.body?.cancel();
		return { _tag: "Redirect", location };
	}
	return read(response, address);
}

/** The page's answer. `address` is the one the model asked for, the page's address when the answer has none. */
async function read(response: Response, address: string): Promise<Hop | PageRefused> {
	const type = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		await response.body?.cancel();
		return new PageRefused({ reason: "status", status: response.status });
	}
	const url = response.url || address;
	// An image or another file is there, which is often what the model wants to know. Not an error.
	if (!HTML.test(type) && !TEXT.test(type)) {
		await response.body?.cancel();
		const kind = type.split(";")[0] || "a file of an unknown type";
		return { _tag: "Page", page: { url, title: "", text: `The address answers with ${kind}, not text, so it cannot be read. It exists.`, truncated: false } };
	}

	const raw = decode(await readCapped(response.body), type);
	const page = HTML.test(type) ? readable(raw) : { title: "", text: raw };
	const text = tidy(page.text);
	return { _tag: "Page", page: { url, title: page.title, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS } };
}

/** Public http(s) on the usual ports only. Host names are checked again when they resolve. */
const checkedUrl = (address: string) =>
	Effect.suspend(() => {
		let url: URL;
		try {
			url = new URL(address);
		} catch {
			return Effect.fail(new PageRefused({ reason: "invalid" }));
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return Effect.fail(new PageRefused({ reason: "scheme" }));
		if (url.port && url.port !== "80" && url.port !== "443") return Effect.fail(new PageRefused({ reason: "port" }));
		if (url.username || url.password) return Effect.fail(new PageRefused({ reason: "credentials" }));
		const host = url.hostname.replace(/^\[|\]$/g, "");
		// A connection to an IP address skips the lookup, so it is checked here.
		if (isIP(host) && NetGuard.isPrivate(host)) return Effect.fail(new PageRefused({ reason: "private" }));
		return Effect.succeed(url);
	});

async function readCapped(body: AsyncIterable<Uint8Array> | null) {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body ?? []) {
		chunks.push(chunk);
		size += chunk.byteLength;
		if (size >= MAX_BYTES) break;
	}
	return Buffer.concat(chunks).subarray(0, MAX_BYTES);
}

function decode(bytes: Buffer, type: string) {
	const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim().replace(/"/g, "") ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** The article text, as a reader view shows it; the whole body when there is no article. */
function readable(html: string) {
	const { document } = parseHTML(html);
	const title = document.title ?? "";
	const article = new Readability(document as unknown as Document).parse();
	return { title: article?.title || title, text: article?.textContent || document.body?.textContent || "" };
}

/**
 * Spaces and tabs become one space, and white space that holds two or more line breaks
 * becomes one empty line. Each run of white space is matched once, so the time grows with
 * the length of the text: a page can be 3 MB of white space that is not a plain space.
 */
export function tidy(text: string) {
	return text
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\s+/g, (space) => (hasTwoLineBreaks(space) ? "\n\n" : space))
		.trim();
}

function hasTwoLineBreaks(space: string) {
	const first = space.indexOf("\n");
	return first !== -1 && space.indexOf("\n", first + 1) !== -1;
}
