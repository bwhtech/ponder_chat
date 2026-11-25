import type { ModelCallStreamPart } from "@ai-sdk/workflow";

/** How long a model's small pieces of text may wait to be joined before they are written. */
export const COALESCE_MS = 30;

type Delta = { type: "text-delta" | "reasoning-delta"; id: string; text: string } | { type: "tool-input-delta"; id: string; delta: string };

/**
 * Writes a model call's parts to the reply's durable stream (model-attempt.ts), joining
 * the small pieces a model streams. A model sends a few characters at a time, and each
 * part written is a row in Postgres, a notification and a read by every page that
 * follows the reply: about 1 ms of the server's CPU per part, most of what a reply cost.
 *
 * The first piece of each text, reasoning or tool input goes out at once, so the first
 * word is never held. The pieces after it wait at most COALESCE_MS, joined into one part.
 * Any other part writes what waits first, so the order stays the same. A piece with
 * provider metadata (such as a reasoning signature) is never joined.
 *
 * `write` resolves when the part is written, or at once when it waits to be joined; a
 * failed write fails the next `write` and `flush`. `flush` writes what waits, and must
 * be called when the stream ends.
 */
export class CoalescingWriter {
	private pending: Delta | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private written: Promise<void> = Promise.resolve();
	private readonly started = new Set<string>();

	constructor(
		private readonly writer: WritableStreamDefaultWriter<ModelCallStreamPart>,
		private readonly windowMs = COALESCE_MS,
	) {}

	write(part: ModelCallStreamPart): Promise<void> {
		const delta = joinable(part);
		const key = delta && `${delta.type}:${delta.id}`;
		if (!delta || !key || !this.started.has(key)) {
			if (key) this.started.add(key);
			this.flush();
			return this.send(part);
		}
		if (this.pending && sameDelta(this.pending, delta)) {
			this.pending = joined(this.pending, delta);
			return Promise.resolve();
		}
		const flushed = this.flush();
		this.pending = { ...delta };
		this.timer = setTimeout(() => void this.flush().catch(() => undefined), this.windowMs);
		return flushed;
	}

	/** Writes the piece that waits, if any, and resolves when every part so far is written. */
	flush(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const pending = this.pending;
		this.pending = undefined;
		return pending ? this.send(pending as ModelCallStreamPart) : this.written;
	}

	private send(part: ModelCallStreamPart): Promise<void> {
		this.written = this.written.then(() => this.writer.write(part));
		return this.written;
	}
}

/** The part as a piece that may be joined: a delta with no provider metadata. */
function joinable(part: ModelCallStreamPart): Delta | undefined {
	const value = part as Record<string, unknown>;
	if (value.providerMetadata !== undefined || typeof value.id !== "string") return undefined;
	if ((value.type === "text-delta" || value.type === "reasoning-delta") && typeof value.text === "string") return part as unknown as Delta;
	if (value.type === "tool-input-delta" && typeof value.delta === "string") return part as unknown as Delta;
	return undefined;
}

function sameDelta(a: Delta, b: Delta) {
	return a.type === b.type && a.id === b.id;
}

function joined(a: Delta, b: Delta): Delta {
	if (a.type === "tool-input-delta" && b.type === "tool-input-delta") return { ...a, delta: a.delta + b.delta };
	if (a.type !== "tool-input-delta" && b.type !== "tool-input-delta") return { ...a, text: a.text + b.text };
	return a;
}
