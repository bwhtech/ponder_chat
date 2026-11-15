/**
 * The guard for addresses that people and the model choose. Private addresses are refused
 * before a connection opens, so these tests need no network. The redirect rules run
 * against a small server of the test's own on 127.0.0.1, with private networks allowed,
 * as for MCP_ALLOW_PRIVATE_NETWORKS=1.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "../config.ts";
import * as NetGuard from "./NetGuard.ts";

const guardWith = (env: Record<string, string>) => NetGuard.layer.pipe(Layer.provide(PonderConfig.layerFromEnv(env)));
const strict = guardWith({});
const local = guardWith({ MCP_ALLOW_PRIVATE_NETWORKS: "1" });

describe("isPrivate", () => {
	it("knows this machine, the tailnet and private networks", () => {
		for (const address of ["127.0.0.1", "10.1.2.3", "100.100.1.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::FFFF:127.0.0.1"])
			assert.isTrue(NetGuard.isPrivate(address), address);
		for (const address of ["1.1.1.1", "93.184.215.14", "2606:4700::1111", "::ffff:1.1.1.1"]) assert.isFalse(NetGuard.isPrivate(address), address);
	});

	it("refuses a private host written as an address, and leaves names to the lookup", () => {
		assert.throws(() => NetGuard.assertPublicHost(new URL("https://[::1]/")), /private network/);
		assert.throws(() => NetGuard.assertPublicHost(new URL("https://10.0.0.5/mcp")), /private network/);
		assert.doesNotThrow(() => NetGuard.assertPublicHost(new URL("https://example.com/")));
	});
});

describe("mcpUrlProblem", () => {
	it.effect("asks for a public https address without a user, a password or a fragment", () =>
		Effect.gen(function* () {
			const guard = yield* NetGuard.NetGuard;
			for (const address of ["https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://[::1]/mcp", "https://localhost/mcp", "https://box.local/mcp", "https://db.internal/mcp"])
				assert.match(Option.getOrThrow(guard.mcpUrlProblem(address)), /private network/, address);
			assert.strictEqual(Option.getOrThrow(guard.mcpUrlProblem("http://example.com/mcp")), "Use an https address. Ponder sends sign-ins only over https.");
			assert.match(Option.getOrThrow(guard.mcpUrlProblem("https://me:pw@example.com/mcp")), /user name and password/);
			assert.match(Option.getOrThrow(guard.mcpUrlProblem("https://example.com/mcp#x")), /# part/);
			assert.match(Option.getOrThrow(guard.mcpUrlProblem("example.com/mcp")), /full address/);
			// A *.ts.net name can be public, through Tailscale Funnel.
			assert.isTrue(Option.isNone(guard.mcpUrlProblem("https://box.tail1234.ts.net/mcp")));
			assert.isTrue(Option.isNone(guard.mcpUrlProblem("https://mcp.example.com/mcp")));
			assert.isFalse(guard.privateNetworksAllowed);
		}).pipe(Effect.provide(strict)),
	);

	it.effect("allows private addresses and http with MCP_ALLOW_PRIVATE_NETWORKS=1", () =>
		Effect.gen(function* () {
			const guard = yield* NetGuard.NetGuard;
			assert.isTrue(guard.privateNetworksAllowed);
			assert.isTrue(Option.isNone(guard.mcpUrlProblem("http://127.0.0.1:3000/mcp")));
			// Still no password in the address.
			assert.isTrue(Option.isSome(guard.mcpUrlProblem("http://me:pw@127.0.0.1/mcp")));
		}).pipe(Effect.provide(local)),
	);
});

describe("the guarded fetch", () => {
	let server: Server;
	let base = "";
	const hits: string[] = [];

	beforeAll(async () => {
		server = createServer((request, response) => {
			hits.push(`${request.method} ${request.url}`);
			const hop = /^\/hop\/(\d+)$/.exec(request.url ?? "");
			if (hop) {
				const left = Number(hop[1]);
				response.writeHead(302, { location: left > 0 ? `/hop/${left - 1}` : "/end" }).end();
				return;
			}
			if (request.url === "/post") return void response.writeHead(307, { location: "/end" }).end();
			response.writeHead(200, { "content-type": "text/plain" }).end("end");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

	it.effect("refuses http and private addresses before it connects", () =>
		Effect.gen(function* () {
			const guard = yield* NetGuard.NetGuard;
			const refused = (address: string) => Effect.flip(Effect.tryPromise({ try: () => guard.fetch(address), catch: (error) => error }));
			assert.match(String(yield* refused(`${base}/end`)), /Only https addresses can be used/);
			assert.match(String(yield* refused("https://127.0.0.1/")), /private network/);
			assert.match(String(yield* refused("https://[::1]:8443/")), /private network/);
			// A name that resolves to a private address is refused when the connection opens.
			const named = yield* refused("https://localhost:8443/");
			assert.match(String((named as { cause?: unknown }).cause), /localhost is on a private network/);
			assert.deepStrictEqual(hits, []);
		}).pipe(Effect.provide(strict)),
	);

	it.effect("follows at most 3 redirects of a GET", () =>
		Effect.gen(function* () {
			const guard = yield* NetGuard.NetGuard;
			const followed = yield* Effect.promise(() => guard.fetch(`${base}/hop/2`));
			assert.strictEqual(followed.status, 200);
			assert.strictEqual(yield* Effect.promise(() => followed.text()), "end");
			const tooMany = yield* Effect.flip(Effect.tryPromise({ try: () => guard.fetch(`${base}/hop/3`), catch: (error) => error }));
			assert.match(String(tooMany), /redirects too many times/);
		}).pipe(Effect.provide(local)),
	);

	it.effect("gives a POST its redirect as the answer", () =>
		Effect.gen(function* () {
			hits.length = 0;
			const guard = yield* NetGuard.NetGuard;
			const response = yield* Effect.promise(() => guard.fetch(`${base}/post`, { method: "POST", body: "{}" }));
			assert.strictEqual(response.status, 307);
			assert.strictEqual(response.headers.get("location"), "/end");
			assert.deepStrictEqual(hits, ["POST /post"]);
		}).pipe(Effect.provide(local)),
	);
});
