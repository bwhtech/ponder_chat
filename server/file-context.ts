import type { UIMessage } from "ai";
import { loadFile, pdfText, SPREADSHEET_TYPES, TEXT_TYPES, URL_PREFIX, type LoadedFile } from "./files.ts";

/**
 * Attached files as the model reads them. Messages carry only links (files.ts); before
 * each model call these are swapped for content: images and PDFs as file data, text
 * files as text. A model that can't read PDFs gets the PDF's text, read once on this
 * server, while admins leave that setting on. The saved thread keeps the links.
 *
 * All file text in one call shares a budget, newest files first, so a chat with many
 * long files does not overflow the model. Only the owner's files are read: a link to
 * someone else's file reads as "no longer available".
 */
const MAX_FILE_CHARS = 200_000;
/** All file text in one call. About 75,000 tokens. */
const MAX_CALL_CHARS = 300_000;
/** With less room than this left, a file is named but not included. */
const MIN_FILE_CHARS = 2_000;

type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;
type Options = { pdfAsText: boolean };

export async function resolveFileParts(messages: UIMessage[], owner: string, options: Options): Promise<UIMessage[]> {
	return new FileContext(owner, options).resolve(messages);
}

class FileContext {
	private room = MAX_CALL_CHARS;

	constructor(
		private owner: string,
		private options: Options,
	) {}

	/** Newest message first, so the budget goes to the files the person attached last. */
	async resolve(messages: UIMessage[]) {
		const resolved: UIMessage[] = [];
		for (const message of [...messages].reverse()) resolved.unshift(await this.resolveMessage(message));
		return resolved;
	}

	private async resolveMessage(message: UIMessage): Promise<UIMessage> {
		if (!message.parts.some(isStoredFile)) return message;
		const parts: UIMessage["parts"] = [];
		for (const part of message.parts) parts.push(...(isStoredFile(part) ? await this.resolvePart(part) : [part]));
		return { ...message, parts };
	}

	private async resolvePart(part: FilePart): Promise<UIMessage["parts"]> {
		const id = part.url.slice(URL_PREFIX.length);
		const file = await loadFile(id, this.owner);
		if (!file) return [text(`[The attached file "${part.filename ?? "file"}" is no longer available.]`)];
		const attached = `The person attached "${file.name}" (${file.media_type}, file id ${id}).`;

		if (Object.values(SPREADSHEET_TYPES).includes(file.media_type)) {
			return [text(`${attached} It is a spreadsheet: read it with run_python, passing this file id as an input.`)];
		}
		if (TEXT_TYPES.has(file.media_type)) return [this.textOf(attached, "Its contents", file.data.toString("utf8"))];
		if (file.media_type === "application/pdf" && this.options.pdfAsText) {
			const pdf = await pdfText(id, file);
			// A scan has no text: the model gets the PDF, and OpenRouter's parser reads it.
			if (pdf) return [this.textOf(attached, "Its text, read from the PDF", pdf)];
		}
		return [text(attached), { ...part, url: dataUrl(file) }];
	}

	/** The text in a fence, cut to the room left. */
	private textOf(attached: string, label: string, content: string) {
		const limit = Math.min(MAX_FILE_CHARS, this.room);
		if (limit < MIN_FILE_CHARS) {
			return text(`${attached} It is not included here: the files in this chat are too long to send together. If you need it, ask the person to attach it again in a new chat.`);
		}
		const cut = content.length > limit;
		const body = cut ? content.slice(0, limit) : content;
		this.room -= body.length;
		return text(`${attached} ${label}${cut ? `, cut to the first ${limit} characters` : ""}:\n\n\`\`\`\n${body}\n\`\`\``);
	}
}

function text(value: string) {
	return { type: "text" as const, text: value };
}

function dataUrl(file: LoadedFile) {
	return `data:${file.media_type};base64,${file.data.toString("base64")}`;
}

function isStoredFile(part: UIMessage["parts"][number]): part is FilePart {
	return part.type === "file" && part.url.startsWith(URL_PREFIX);
}
