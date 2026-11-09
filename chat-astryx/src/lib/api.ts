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
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new ApiError(data.error ?? options.failure ?? `Something went wrong (${response.status}).`, response.status, data.errors);
	return data as T;
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
