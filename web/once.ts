/** Calls `load` the first time only, and gives every caller its promise. A load that fails is tried again next time. */
export function once<T>(load: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return () =>
		(promise ??= load().catch((error: unknown) => {
			promise = undefined;
			throw error;
		}));
}
