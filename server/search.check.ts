/**
 * Checks web_fetch's guard: no address on this machine, the tailnet or a private network
 * can be read, by IP address or by name. Redirects go through the same checks. --live also reads a real page and
 * makes one real search (about $0.007).
 * Run: npx tsx server/search.check.ts [--live]   (--live needs OPENROUTER_API_KEY)
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { isPrivate } from "./net/NetGuard.ts";
import { runPromise } from "./runtime/runtime.ts";
import * as SearchBackend from "./search/backend.ts";
import { fetchPage as fetchPageEffect } from "./search/fetch-page.ts";
import { executeWebFetch as executeWebFetchEffect } from "./search/tool.ts";

// On the app's runtime: NetGuard for the pages, and OpenRouter's key for --live.
const fetchPage = (address: string) => runPromise(fetchPageEffect(address));
const executeWebFetch = (input: { url: string }) => runPromise(executeWebFetchEffect(input));

const live = process.argv.includes("--live");
let failed = 0;

async function check(name: string, body: () => Promise<void>) {
	try {
		await body();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : error}`);
	}
}

async function refused(address: string) {
	const reply = await executeWebFetch({ url: address });
	assert.ok("error" in reply && reply.error, `${address} was read`);
	return reply.error;
}

await check("private and special addresses are private; public ones are not", async () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "100.100.1.1", "169.254.169.254", "192.168.1.1", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:127.0.0.1"]) {
		assert.ok(isPrivate(address), address);
	}
	for (const address of ["1.1.1.1", "93.184.215.14", "2606:4700::1111"]) assert.ok(!isPrivate(address), address);
});

await check("IP addresses, localhost and (on the tailnet) the tailnet name are refused", async () => {
	const addresses = ["http://127.0.0.1/", "http://[::1]/", "http://localhost/", "http://169.254.169.254/latest/meta-data/"];
	// Off the tailnet this name resolves to Tailscale's public Funnel address, which is public.
	const tailnet = await lookup("hussain-coding.tail5c9b7d.ts.net").catch(() => undefined);
	if (tailnet && isPrivate(tailnet.address)) addresses.push("https://hussain-coding.tail5c9b7d.ts.net/");
	for (const address of addresses) assert.match(await refused(address), /private network/, address);
});

await check("other schemes, ports and user names are refused", async () => {
	assert.match(await refused("file:///etc/passwd"), /http and https/);
	assert.match(await refused("https://example.com:8443/"), /ports/);
	assert.match(await refused("https://user:pass@example.com/"), /user name/);
});

if (live) {
	await check("a public page is read as text", async () => {
		const page = await fetchPage("https://en.wikipedia.org/wiki/Pune");
		assert.match(page.title, /Pune/);
		assert.ok(page.text.length > 2_000, `only ${page.text.length} characters`);
	});

	await check("a public name that points at this machine is refused", async () => {
		// nip.io answers 127.0.0.1 for this name. A redirect goes through the same checks.
		assert.match(await refused("http://127.0.0.1.nip.io/"), /private network/);
	});

	await check("a redirect is followed", async () => {
		const page = await fetchPage("https://httpbin.org/redirect-to?url=https://example.com/");
		assert.equal(new URL(page.url).hostname, "example.com");
	});

	await check("a search returns results with addresses and text, and a cost", async () => {
		const reply = await runPromise(SearchBackend.SearchBackend.use((backend) => backend.search("Vercel AI SDK latest release")));
		assert.ok(reply.results.length >= 2, `${reply.results.length} results`);
		assert.ok(reply.results.every((result) => result.url.startsWith("http") && result.text.length > 0));
		assert.ok((reply.costUsd ?? 0) > 0, "no cost");
		console.log(`     ${reply.results.length} results, $${reply.costUsd?.toFixed(4)}: ${reply.results.map((result) => new URL(result.url).hostname).join(", ")}`);
	});
}

process.exit(failed ? 1 : 0);
