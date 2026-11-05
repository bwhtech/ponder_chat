import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch } from "undici";

/**
 * web_fetch: reads a page on our own server, so no other company sees what is read.
 * The model picks the address, so a page must not reach this machine, the tailnet or
 * any private network: every address a host name resolves to is checked when the
 * connection opens (so DNS cannot change it after the check), and on every redirect.
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
			dispatcher: agent,
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
	// A connection to an IP address skips the lookup below, so it is checked here.
	if (isIP(host) && isPrivate(host)) throw new Error("That address is on a private network.");
	return url;
}

const agent = new Agent({ connect: { lookup: publicLookup } });

/** dns.lookup, without the private addresses, for every connection the agent opens. */
function publicLookup(hostname: string, options: Parameters<LookupFunction>[1], callback: Parameters<LookupFunction>[2]) {
	lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
		if (error) return callback(error, "");
		const allowed = addresses.filter((entry) => !isPrivate(entry.address));
		if (!allowed.length) return callback(new Error(`${hostname} is on a private network.`), "");
		if (options.all) return callback(null, allowed);
		callback(null, allowed[0]!.address, allowed[0]!.family);
	});
}

const PRIVATE = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
	["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

export function isPrivate(address: string) {
	// An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
	if (mapped) return PRIVATE.check(mapped, "ipv4");
	return PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
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
