import type { ProviderMetadata, UIMessageChunk } from "ai";

/**
 * Joins the delta chunks of a run's stream before saveReply (reply.ts) replays it. For
 * each chunk, the AI SDK's readUIMessageStream clones the whole message, and for each
 * tool-input-delta it also parses the whole input so far. So a reply saved in time that
 * grew with the square of its length, on the event loop: 400 KB of tool input in
 * 40-character pieces held the server for about 20 seconds, and 20,000 text deltas after
 * a 400 KB input for about 10. Joined, the message is the same:
 *
 * - A tool call's input deltas join across the other calls' deltas, in a map by call id.
 *   The message keeps only the last parse of each input, and a call's part sits where its
 *   tool-input-start put it. They are released, in the order first seen, at any other chunk.
 * - A run of text deltas, or of reasoning deltas, of one part joins into one delta. The
 *   SDK keeps the last providerMetadata a delta brings (`chunk.providerMetadata ??
 *   part.providerMetadata`), so the joined delta brings the run's last one that is set.
 *
 * Only the save joins. The live stream does not: a reconnect counts its chunks.
 */
export function joinDeltas() {
	const joiner = new DeltaJoiner();
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform: (chunk, controller) => joiner.take(chunk, (each) => controller.enqueue(each)),
		flush: (controller) => joiner.release((each) => controller.enqueue(each)),
	});
}

type Emit = (chunk: UIMessageChunk) => void;
type ToolInputDelta = Extract<UIMessageChunk, { type: "tool-input-delta" }>;
type TextDelta = Extract<UIMessageChunk, { type: "text-delta" | "reasoning-delta" }>;

class DeltaJoiner {
	private inputs = new Map<string, { chunk: ToolInputDelta; pieces: string[] }>();
	private text: { chunk: TextDelta; pieces: string[]; metadata: ProviderMetadata | undefined } | undefined;

	take(chunk: UIMessageChunk, emit: Emit) {
		if (chunk.type === "tool-input-delta") return this.takeInput(chunk, emit);
		if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return this.takeText(chunk, emit);
		this.release(emit);
		emit(chunk);
	}

	/** Everything held, in the order it came: the text run, or the tool inputs by first delta. */
	release(emit: Emit) {
		this.releaseText(emit);
		for (const { chunk, pieces } of this.inputs.values()) emit({ ...chunk, inputTextDelta: pieces.join("") });
		this.inputs.clear();
	}

	private takeInput(chunk: ToolInputDelta, emit: Emit) {
		this.releaseText(emit);
		const held = this.inputs.get(chunk.toolCallId);
		if (held) held.pieces.push(chunk.inputTextDelta);
		else this.inputs.set(chunk.toolCallId, { chunk, pieces: [chunk.inputTextDelta] });
	}

	private takeText(chunk: TextDelta, emit: Emit) {
		const held = this.text;
		if (held && held.chunk.type === chunk.type && held.chunk.id === chunk.id) {
			held.pieces.push(chunk.delta);
			held.metadata = chunk.providerMetadata ?? held.metadata;
			return;
		}
		this.release(emit);
		this.text = { chunk, pieces: [chunk.delta], metadata: chunk.providerMetadata ?? undefined };
	}

	private releaseText(emit: Emit) {
		if (!this.text) return;
		const { chunk, pieces, metadata } = this.text;
		const { providerMetadata: _first, ...rest } = chunk;
		emit({ ...rest, delta: pieces.join(""), ...(metadata && { providerMetadata: metadata }) } as TextDelta);
		this.text = undefined;
	}
}
