/**
 * Token budgets and estimates for compaction (docs: README, "What the model reads").
 * No Node imports: the chat workflow uses this file too.
 *
 * Adapted from vercel/eve's compaction engine (packages/eve/src/harness/compaction/).
 */

/** Compaction starts at this share of the model's window... */
export const THRESHOLD = 0.9;
/** ...or at this many tokens, whichever is lower: longer calls cost more and answer worse. */
export const MAX_TRIGGER_TOKENS = 200_000;
/** The window to assume when OpenRouter's list does not give one. */
export const UNKNOWN_WINDOW = 128_000;
/** The recent history kept word for word after a compaction. */
export const KEPT_TAIL_TOKENS = 20_000;
/**
 * Provider tokens per estimated token, until a call of this thread is measured. Bytes ÷ 4
 * runs low on JSON, addresses and most languages other than English.
 */
export const DEFAULT_RATIO = 1.6;

/** Uploads are at most 1,568 pixels on the long side (image-resize.ts). */
const IMAGE_TOKENS = 1_600;
const PDF_BYTES_PER_TOKEN = 12;
const MIN_PDF_TOKENS = 3_000;
const MIN_RATIO = 0.5;
const MAX_RATIO = 8;

export type Budget = {
	/** Over this, the history is compacted. */
	trigger: number;
	/** Over this, the call is not sent at all: 90% of the real window. */
	limit: number;
	/** The most that is kept word for word. */
	tail: number;
	/** What a compaction aims for, so the next one is far away. */
	target: number;
};

export function budgetFor(window: number | null | undefined): Budget {
	const size = window && window > 0 ? window : UNKNOWN_WINDOW;
	const limit = Math.floor(size * THRESHOLD);
	const trigger = Math.min(limit, MAX_TRIGGER_TOKENS);
	return { trigger, limit, tail: Math.min(KEPT_TAIL_TOKENS, Math.floor(trigger / 2)), target: Math.floor(trigger / 2) };
}

/**
 * An estimate in two parts. The thread's measured ratio corrects `text` only. `media`
 * (images, PDFs) is a guess from the file's size, so it never refuses a message or drops
 * a file on its own: the provider measures it.
 */
export type Estimate = { text: number; media: number };

/** Estimated provider tokens: text corrected by the measured ratio, media as estimated. */
export function countTokens({ text, media }: Estimate, ratio: number) {
	return Math.ceil(ratio * text + media);
}

export function addEstimates(...estimates: Estimate[]): Estimate {
	return { text: estimates.reduce((sum, each) => sum + each.text, 0), media: estimates.reduce((sum, each) => sum + each.media, 0) };
}

/**
 * The measured ratio for a call: its input tokens, less the media estimate, per estimated
 * text token, within sane bounds so one odd call can't skew the thread. Undefined for a
 * call that is mostly media: there the guess for the media would decide the ratio.
 */
export function measuredRatio(inputTokens: number, estimated: Estimate) {
	if (!(inputTokens > 0) || !(estimated.text > 0) || estimated.media > estimated.text) return undefined;
	return Math.min(MAX_RATIO, Math.max(MIN_RATIO, (inputTokens - estimated.media) / estimated.text));
}

/** Estimated tokens of any message value, text and media together. */
export function estimateTokens(value: unknown): number {
	const { text, media } = estimate(value);
	return text + media;
}

/**
 * Estimated tokens of any message value: UI messages, model messages or a provider
 * prompt. Text is UTF-8 bytes of its JSON ÷ 4. A file or image part counts once, at the
 * rate for its kind, however deep its data sits ({ data: { type: "data", data } } in a
 * provider prompt), and never by the length of its base64.
 */
export function estimate(value: unknown): Estimate {
	let media = 0;
	const json =
		JSON.stringify(value, function (key, item) {
			if (key === "providerOptions" || key === "providerMetadata") return undefined;
			// An approval is not sent to the provider, and it repeats the call's whole input: counted, an approved call would count twice.
			if (key === "inputSchemaInput" || isApproval(item)) return undefined;
			const file = filePart(item);
			if (!file) return item;
			media += mediaTokens(file.type, file.bytes);
			return { type: (item as { type?: unknown }).type, mediaType: file.type };
		}) ?? "";
	return { text: Math.ceil(utf8Length(json) / 4), media };
}

/** An image or PDF counts the same however it is sent. */
function isApproval(item: unknown) {
	const type = (item as { type?: unknown } | null)?.type;
	return type === "tool-approval-request" || type === "tool-approval-response";
}

function mediaTokens(type: string, bytes: number) {
	if (type.startsWith("image/")) return IMAGE_TOKENS;
	if (type === "application/pdf") return Math.max(MIN_PDF_TOKENS, Math.ceil(bytes / PDF_BYTES_PER_TOKEN));
	return Math.ceil(bytes / 4);
}

/** A part that carries file data: its media type and size. A part with only a link is text. */
function filePart(item: unknown): { type: string; bytes: number } | undefined {
	if (!item || typeof item !== "object" || item instanceof Uint8Array) return undefined;
	const part = item as { type?: unknown; mediaType?: unknown; data?: unknown; url?: unknown; image?: unknown };
	const declared = typeof part.mediaType === "string" ? part.mediaType : part.type === "image" ? "image/*" : undefined;
	if (!declared) return undefined;
	const nested = part.data && typeof part.data === "object" && !(part.data instanceof Uint8Array) ? (part.data as { data?: unknown }).data : undefined;
	const payload = [part.data, nested, part.url, part.image].map(payloadOf).find(Boolean);
	return payload && { type: payload.type ?? declared, bytes: payload.bytes };
}

/** The size of binary data: bytes, a data: URL, or base64. */
function payloadOf(item: unknown): { type?: string; bytes: number } | undefined {
	if (item instanceof Uint8Array || item instanceof ArrayBuffer) return { bytes: item.byteLength };
	if (typeof item !== "string") return undefined;
	if (item.startsWith("data:")) {
		const comma = item.indexOf(",");
		return { type: item.slice(5, comma).split(";")[0] || undefined, bytes: Math.floor(((item.length - comma - 1) * 3) / 4) };
	}
	if (item.length > 1_000 && /^[A-Za-z0-9+/=\s]+$/.test(item.slice(0, 200))) return { bytes: Math.floor((item.length * 3) / 4) };
	return undefined;
}

function utf8Length(text: string) {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		// A surrogate pair is one 4-byte character.
		else if (code >= 0xd800 && code < 0xdc00) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}
