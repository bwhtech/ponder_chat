import type { ClientResponse } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { ApiClient, AppType } from "#server/app";
import { once } from "./once";

/**
 * The typed API client. Its paths, inputs and answers come from the server's routes
 * (AppType in server/app.ts), as types only, so no server code reaches the browser. Path
 * params go into the address as they are: encode them. Read the answer with unwrap():
 *
 *   const { threads } = await unwrap(client.api.threads.search.$get({ query: { q } }));
 *
 * The first page asks the API nothing (its data comes with it, boot.ts), so hono's client
 * loads at the first request (api-client.ts): `client` notes the path, such as
 * api.threads[":id"].$get, and calls it on the real client once that is here. Every call
 * returns a promise either way.
 */
const loadClient = once(() => import("./api-client").then(({ hc }) => hc<AppType>("/")));
export const client = pathTo([]) as ApiClient;

function pathTo(path: PropertyKey[]): unknown {
	return new Proxy(() => {}, {
		// Not a promise: `await client.api` must not wait for a "then".
		get: (_, key) => (key === "then" ? undefined : pathTo([...path, key])),
		apply: (_, __, args: unknown[]) =>
			loadClient().then((real) => {
				let target = real as unknown as Record<PropertyKey, unknown>;
				for (const key of path.slice(0, -1)) target = target[key] as Record<PropertyKey, unknown>;
				return (target[path.at(-1)!] as (...args: unknown[]) => unknown)(...args);
			}),
	});
}

/**
 * The JSON of a typed client call's successful answer. On a refusal it throws the server's
 * own message (`{ error }`), or `failure` when the server sent none, so the page can show it.
 * A 500 is an unexpected error, and its message only says so (onError in server/app.ts),
 * so there `failure`, which names what failed, comes first.
 */
export async function unwrap<R extends ClientResponse<unknown>>(call: R | Promise<R>, failure?: string): Promise<Success<R>> {
	const response = await call;
	const data = (await response.json().catch(() => ({}))) as { error?: string; errors?: unknown };
	const message = response.status === 500 ? (failure ?? data.error) : (data.error ?? failure);
	if (!response.ok) throw new ApiError(message ?? `Something went wrong (${response.status}).`, response.status, data.errors);
	return data as Success<R>;
}

/** A route's successful answer, to name its type: `type Me = Answer<typeof client.api.me.$get>`. */
export type Answer<Call extends (...args: any[]) => unknown> = Success<Awaited<ReturnType<Call>>>;

/** The server's message, with its HTTP status, so a page can tell "not found" from a failure. */
export class ApiError extends Error {
	readonly status: number;
	/** The problems behind a refusal, one per line, when the server lists them (a skill file). */
	readonly errors: string[];
	constructor(message: string, status: number, errors: unknown = []) {
		super(message);
		this.status = status;
		this.errors = Array.isArray(errors) ? errors.map(String) : [];
	}
}

/** The body of the 2xx JSON answers a route can give. `any` for the check without the server (tsconfig.no-node.json). */
type Success<R> = 0 extends 1 & R ? any : R extends ClientResponse<infer Body, infer Status, "json"> ? (Status extends SuccessStatusCode ? Body : never) : never;
