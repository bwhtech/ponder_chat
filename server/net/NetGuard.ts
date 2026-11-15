import { lookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Agent, fetch as undiciFetch } from "undici";
import * as PonderConfig from "../config.ts";

/**
 * Outbound requests to addresses that people or the model choose: web_fetch, and MCP
 * servers with their OAuth endpoints. None of them may reach this machine, the tailnet or
 * a private network. Every address a host name resolves to is checked when each
 * connection opens, so DNS cannot change it after the check.
 *
 * MCP_ALLOW_PRIVATE_NETWORKS=1 turns the check off, and allows http, for MCP only. It is
 * for development and the checks (server/mcp.check.ts). Never set it in production. It is
 * read from the config, when the runtime starts.
 */
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

/** A host written as an IP address skips the lookup, so it is checked here. Throws for a private one. */
export function assertPublicHost(url: URL) {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) && isPrivate(host)) throw new Error("That address is on a private network.");
}

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

const MAX_REDIRECTS = 3;

export class NetGuard extends Context.Service<
	NetGuard,
	{
		/** MCP_ALLOW_PRIVATE_NETWORKS=1: connectors may reach private addresses, over http too. */
		readonly privateNetworksAllowed: boolean;
		/** An undici agent that connects to public addresses only, for web_fetch (search/fetch-page.ts). */
		readonly publicAgent: Agent;
		/**
		 * fetch for MCP servers and their OAuth endpoints: public addresses only. A GET follows
		 * at most 3 redirects, each checked; any other method gets the redirect as its answer.
		 * A server that redirects a POST is not followed, as MCP transports expect.
		 *
		 * A plain fetch function, for the libraries that take one (@ai-sdk/mcp). Effect code
		 * that wants an HttpClient on it provides it as FetchHttpClient.Fetch.
		 */
		readonly fetch: typeof fetch;
		/** Why an MCP server URL can't be used, or none. https only, no user name or password, public hosts. */
		readonly mcpUrlProblem: (address: string) => Option.Option<string>;
	}
>()("ponder/net/NetGuard") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const local = config.allowPrivateNetworks;
	// Closed with the runtime. destroy, not close: close would wait for requests still in flight.
	const publicAgent = yield* Effect.acquireRelease(
		Effect.sync(() => new Agent({ connect: { lookup: publicLookup } })),
		(agent) => Effect.promise(() => agent.destroy()),
	);

	const guardedFetch: typeof fetch = async (input, init) => {
		let url = new URL(input instanceof Request ? input.url : String(input));
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		for (let redirects = 0; ; redirects++) {
			if (!local) {
				if (url.protocol !== "https:") throw new Error("Only https addresses can be used.");
				assertPublicHost(url);
			}
			const response = await undiciFetch(url, {
				...(init as object),
				...(input instanceof Request && !init ? { headers: input.headers, body: input.body, method } : {}),
				redirect: "manual",
				dispatcher: local ? undefined : publicAgent,
			} as Parameters<typeof undiciFetch>[1]);
			const location = response.headers.get("location");
			const followable = (method === "GET" || method === "HEAD") && response.status >= 300 && response.status < 400 && location;
			if (!followable) return response as unknown as Response;
			await response.body?.cancel();
			if (redirects >= MAX_REDIRECTS) throw new Error("The server redirects too many times.");
			url = new URL(location, url);
		}
	};

	const mcpUrlProblem = (address: string): Option.Option<string> => {
		let url: URL;
		try {
			url = new URL(address);
		} catch {
			return Option.some("Enter the full address, starting with https://.");
		}
		if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return Option.some("Use an https address. Ponder sends sign-ins only over https.");
		if (url.username || url.password) return Option.some("Leave the user name and password out of the address. Add them as a header instead.");
		if (url.hash) return Option.some("Leave the # part out of the address.");
		if (local) return Option.none();
		const host = url.hostname.replace(/^\[|\]$/g, "");
		// A name can still resolve to a private address; the connection checks that. (A
		// *.ts.net name can be public, through Tailscale Funnel, so it is not refused by name.)
		if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host) || (isIP(host) && isPrivate(host)))
			return Option.some(`${url.hostname} is on a private network. Ponder connects only to servers on the public internet.`);
		return Option.none();
	};

	return NetGuard.of({ privateNetworksAllowed: local, publicAgent, fetch: guardedFetch, mcpUrlProblem });
});

export const layer = Layer.effect(NetGuard, make);
