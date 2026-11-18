/**
 * JSON in the tests and checks, typed as the shape the test expects. The body is not
 * checked here: the test's assertions are the check, and a body of another shape fails them.
 */
export async function jsonBody<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

/** JSON text, typed as the shape the test expects, as jsonBody. */
export function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}
