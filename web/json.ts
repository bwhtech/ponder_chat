import type { UIMessage } from "ai";

/**
 * Checks for JSON this page did not just get from the typed client: what it kept on the
 * device (localStorage, IndexedDB), possibly from an older version, and a few raw fetches.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chat messages, checked down to each message's id, role and parts: the chat reads the parts itself. */
export function isMessages(value: unknown): value is UIMessage[] {
	return Array.isArray(value) && value.every(isMessage);
}

/** A plain copy of JSON-safe data, such as a reactive proxy's, for IndexedDB and localStorage. */
export function plainCopy<T>(value: T): T {
	const copy: unknown = JSON.parse(JSON.stringify(value));
	// The same data, without the proxy: for JSON-safe data, JSON keeps its shape.
	return copy as T;
}

function isMessage(value: unknown) {
	return isRecord(value) && typeof value.id === "string" && ROLES.has(value.role) && Array.isArray(value.parts);
}

const ROLES = new Set<unknown>(["system", "user", "assistant"]);
