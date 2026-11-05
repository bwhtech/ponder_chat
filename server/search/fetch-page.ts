import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { isIP } from "node:net";
import { fetch } from "undici";
import { isPrivate, publicAgent } from "../net-guard.ts";

/**
 * web_fetch: reads a page on our own server, so no other company sees what is read.
 * The model picks the address, so a page must not reach this machine, the tailnet or
 * any private network (net-guard.ts), checked again on every redirect.
 */
const MAX_BYTES = 3_000_000;
const MAX_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "PonderChat/1.0 (+https://chat.bwh.tech)";
const HTML = /^(text\/html|application\/xhtml\+xml)/;
const TEXT = /^(text\/(plain|markdown|csv)|application\/json)/;

export type FetchedPage = { url: string; title: string; text: string; truncated: boolean };

export async function fetchPage(address: string): Promise<FetchedPage> {
	const response = await fetchFollowing(address);
	const type = response.headers.get("content-type") ?? "";
	if (!response.ok) throw new Error(`The page answered ${response.status}.`);
	if (!HTML.test(type) && !TEXT.test(type)) throw new Error(`The page is ${type.split(";")[0] || "of an unknown type"}, not text that can be read.`);

	const raw = decode(await readCapped(response.body), type);
	const page = HTML.test(type) ? readable(raw) : { title: "", text: raw };
	const text = tidy(page.text);
	return { url: response.url || address, title: page.title, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

async function fetchFollowing(address: string) {
	let url = checkedUrl(address);
	for (let redirects = 0; ; redirects++) {
		const response = await fetch(url, {
			dispatcher: publicAgent,
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
		});
		const location = response.headers.get("location");
		if (response.status < 300 || response.status >= 400 || !location) return response;
		await response.body?.cancel();
		if (redirects >= MAX_REDIRECTS) throw new Error("The page redirects too many times.");
		url = checkedUrl(new URL(location, url).toString());
	}
}

/** Public http(s) on the usual ports only. Host names are checked again when they resolve. */
function checkedUrl(address: string) {
	const url = new URL(address);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be read.");
	if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only the usual web ports (80 and 443) can be read.");
	if (url.username || url.password) throw new Error("Addresses with a user name or password cannot be read.");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	// A connection to an IP address skips the lookup, so it is checked here.
	if (isIP(host) && isPrivate(host)) throw new Error("That address is on a private network.");
	return url;
}

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

function tidy(text: string) {
	return text.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*(\n\s*)+/g, "\n\n").trim();
}
