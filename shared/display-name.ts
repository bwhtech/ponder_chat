/**
 * A person's name to show. People have no name until they set one, so the start of their
 * email stands in, in title case: "hussain@…" is "Hussain", "jane.doe@…" is "Jane Doe".
 * The server (server/admin/people.ts) and the pages use this one function, so a person
 * has the same name everywhere.
 */
export function displayName(name: string | null | undefined, email: string) {
	return name?.trim() || nameFromEmail(email);
}

/** The start of an email as a name: split at dots, dashes, underscores and pluses, each word capitalised. */
export function nameFromEmail(email: string) {
	const local = email.split("@")[0] ?? "";
	const words = local.split(/[._+-]+/).filter(Boolean);
	if (!words.length) return local;
	return words.map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1)).join(" ");
}
