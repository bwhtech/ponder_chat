/**
 * How connector failures read to the person and the model, and which ones are a refused
 * sign-in (401) or may pass by themselves. The failure a server or the network gave is the
 * cause of a ConnectorFailed, and is read from there.
 */
import { UnauthorizedError } from "@ai-sdk/mcp";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { ConnectorFailed, ConnectorProblem, describeError, isTransient, isUnauthorized, NeedsSignIn, sdkFailure } from "./errors.ts";

const failed = (cause: unknown) => new ConnectorFailed({ operation: "call", cause });

describe("connector errors", () => {
	it("says what the person can do, in fixed sentences", () => {
		assert.strictEqual(new NeedsSignIn().message, "The sign-in ended. Sign in again in Settings, Connectors.");
		assert.strictEqual(new NeedsSignIn({ reason: "unreadable" }).message, "Ponder can't read this connector's sign-in any more. Sign in again.");
		assert.strictEqual(new ConnectorProblem({ reason: "header-reserved", detail: "Host" }).message, "Ponder sets the Host header itself.");
		assert.strictEqual(new ConnectorProblem({ reason: "header-name", detail: "" }).message, "“(empty)” is not a valid header name.");
		assert.strictEqual(describeError(new ConnectorProblem({ reason: "not-found" })), "That connector was not found.");
	});

	it("reads a server's failure from the cause, never from the error's own message", () => {
		assert.strictEqual(describeError(failed(new Cause.TimeoutError())), "The server took too long to answer.");
		assert.strictEqual(describeError(failed(new Error("fetch failed", { cause: new Error("connect ECONNREFUSED") }))), "Could not connect to the server.");
		assert.strictEqual(describeError(failed(new Error("That address is on a private network."))), "The server is on a private network, and Ponder can't reach it.");
		assert.strictEqual(describeError(failed(new Error("HTTP 404"))), "There is no MCP server at that address.");
		assert.strictEqual(describeError(failed(new Error("x".repeat(400)))), `${"x".repeat(300)}…`);
		assert.notInclude(failed(new Error("secret text")).message, "secret");
	});

	it("knows a refused sign-in or key", () => {
		assert.isTrue(isUnauthorized(failed(new UnauthorizedError())));
		assert.isTrue(isUnauthorized(failed(new Error("HTTP 401"))));
		assert.isTrue(isUnauthorized(failed(new Error("Request failed", { cause: new Error("Unauthorized") }))));
		assert.isFalse(isUnauthorized(failed(new Error("HTTP 403"))));
		assert.isFalse(isUnauthorized(new NeedsSignIn()));
	});

	it("knows a failure that may pass by itself", () => {
		assert.isTrue(isTransient(failed(new Cause.TimeoutError())));
		assert.isTrue(isTransient(failed(new Error("HTTP 503"))));
		assert.isTrue(isTransient(failed(new Error("fetch failed", { cause: new Error("ECONNRESET") }))));
		assert.isFalse(isTransient(failed(new Error("HTTP 401"))));
	});

	it("keeps a problem that Ponder's OAuth provider threw inside the SDK", () => {
		const problem = new ConnectorProblem({ reason: "no-verifier" });
		assert.strictEqual(sdkFailure("sign-in")(problem), problem);
		assert.instanceOf(sdkFailure("sign-in")(new Error("x")), ConnectorFailed);
	});
});
