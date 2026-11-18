/**
 * JSON in the tests and checks, typed as the shape the test expects. The body is not
 * checked here: the test's assertions are the check, and a body of another shape fails them.
 * The e2e tests read Playwright's answers with it too (jsonOf in e2e/fixtures.ts).
 */
export async function jsonBody<T>(response: { json(): Promise<unknown> }): Promise<T> {
	return expected<T>(await response.json());
}

/** JSON text, typed as the shape the test expects, as jsonBody. */
export function parseJson<T>(text: string): T {
	return expected<T>(JSON.parse(text));
}

/** A value of no known type, such as a tool's output, typed as the shape the test expects, as jsonBody. */
export function expected<T>(value: unknown): T {
	return value as T;
}
