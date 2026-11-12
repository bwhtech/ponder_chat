import { hc, type ClientResponse } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { ApiClient, AppType } from "#server/app";

/**
 * The typed API client. Its paths, inputs and answers come from the server's routes
 * (AppType in server/app.ts), as types only, so no server code reaches the browser. Path
 * params go into the address as they are: encode them. Read the answer with unwrap():
 *
 *   const { threads } = await unwrap(client.api.threads.search.$get({ query: { q } }));
 */
export const client: ApiClient = hc<AppType>("/");

/**
 * Calls Ponder's API and returns the JSON answer. On a refusal it throws the server's own
 * message (`{ error }`), or `failure` when the server sent none, so the page can show it.
 */
export async function request<T>(url: string, options: { method?: string; body?: unknown; failure?: string } = {}): Promise<T> {
	const hasBody = options.body !== undefined;
	const response = await fetch(url, {
		method: options.method ?? (hasBody ? "POST" : "GET"),
		headers: hasBody ? { "Content-Type": "application/json" } : undefined,
		body: hasBody ? JSON.stringify(options.body) : undefined,
	});
	return readAnswer<T>(response, options.failure);
}

/** The JSON of a typed client call's successful answer. Refusals throw, as with request(). */
export async function unwrap<R extends ClientResponse<unknown>>(response: R | Promise<R>, failure?: string): Promise<Success<R>> {
	return readAnswer<Success<R>>(await response, failure);
}

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

async function readAnswer<T>(response: { ok: boolean; status: number; json(): Promise<unknown> }, failure?: string): Promise<T> {
	const data = (await response.json().catch(() => ({}))) as { error?: string; errors?: unknown };
	if (!response.ok) throw new ApiError(data.error ?? failure ?? `Something went wrong (${response.status}).`, response.status, data.errors);
	return data as T;
}
