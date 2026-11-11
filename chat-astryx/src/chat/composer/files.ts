import type { FileUIPart } from "ai";

/** What the server can pass to the model; spreadsheets only when Python can read them. */
export function acceptList(python: boolean) {
	return `image/png,image/jpeg,image/webp,image/gif,application/pdf,.csv,.tsv,.txt,.md,.json${python ? ",.xlsx,.xls,.ods" : ""}`;
}

/** The same matching as the file dialog's `accept`: extensions, `type/*` and exact media types. */
export function matchesAccept(file: File, accept: string) {
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return accept.split(",").some((rule) => {
		const pattern = rule.trim().toLowerCase();
		if (pattern.startsWith(".")) return name.endsWith(pattern);
		if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
		return type === pattern;
	});
}

/** Uploads the attached files; the message carries links to them. Throws the first failure. */
export function uploadFiles(files: File[]): Promise<FileUIPart[]> {
	return Promise.all(
		files.map(async (file) => {
			const body = new FormData();
			body.append("file", file);
			const response = await fetch("/api/files", { method: "POST", body });
			const result = await response.json().catch(() => ({ error: `"${file.name}" could not be uploaded.` }));
			if (!response.ok) throw new Error(result.error ?? `"${file.name}" could not be uploaded.`);
			return { type: "file" as const, mediaType: result.mediaType, filename: result.name, url: result.url };
		}),
	);
}
