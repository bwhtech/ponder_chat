import { useSyncExternalStore } from "react";

/**
 * A value that several components read and any module can change: the React side of
 * the stores the Vue page kept in refs. Read it with useStore(store) in a component,
 * or store.get() anywhere else.
 */
export type Store<T> = {
	get: () => T;
	set: (next: T | ((previous: T) => T)) => void;
	subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set(next) {
			const resolved = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
			if (Object.is(resolved, value)) return;
			value = resolved;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useStore<T>(store: Store<T>): T {
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}
