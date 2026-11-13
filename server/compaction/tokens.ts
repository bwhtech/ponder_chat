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

/** The measured ratio for a call, kept within sane bounds so one odd call can't skew the thread. */
export function measuredRatio(inputTokens: number, estimated: number) {
	if (!(inputTokens > 0) || !(estimated > 0)) return undefined;
	return Math.min(MAX_RATIO, Math.max(MIN_RATIO, inputTokens / estimated));
}

/**
 * Estimated tokens of any message value (UI messages, model messages, a provider prompt):
 * UTF-8 bytes of its JSON ÷ 4, with images and PDFs counted at their own rate, never by
 * the length of their base64.
 */
export function estimateTokens(value: unknown): number {
	let media = 0;
	const json =
		JSON.stringify(value, function (this: Record<string, unknown>, key, item) {
			if (key === "providerOptions" || key === "providerMetadata") return undefined;
			const payload = mediaPayload(item, this?.mediaType);
			if (!payload) return item;
			media += mediaTokens(payload.type, payload.bytes);
			return "";
		}) ?? "";
	return Math.ceil(utf8Length(json) / 4) + media;
}

/** An image or PDF counts the same however it is sent. */
function mediaTokens(type: string, bytes: number) {
	if (type.startsWith("image/")) return IMAGE_TOKENS;
	if (type === "application/pdf") return Math.max(MIN_PDF_TOKENS, Math.ceil(bytes / PDF_BYTES_PER_TOKEN));
	return Math.ceil(bytes / 4);
}

/** The media type and size of binary data: bytes, a data: URL, or long base64 beside a media type. */
function mediaPayload(item: unknown, holderType: unknown): { type: string; bytes: number } | undefined {
	const type = typeof holderType === "string" ? holderType : "";
	if (item instanceof Uint8Array) return { type, bytes: item.byteLength };
	if (item instanceof ArrayBuffer) return { type, bytes: item.byteLength };
	if (typeof item !== "string") return undefined;
	if (item.startsWith("data:")) {
		const comma = item.indexOf(",");
		const header = item.slice(5, comma);
		return { type: header.split(";")[0] || type, bytes: Math.floor(((item.length - comma - 1) * 3) / 4) };
	}
	if (type && item.length > 1_000 && /^[A-Za-z0-9+/=\s]+$/.test(item.slice(0, 200))) return { type, bytes: Math.floor((item.length * 3) / 4) };
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
