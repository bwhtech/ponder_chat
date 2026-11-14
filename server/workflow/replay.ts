import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { joinDeltas } from "./join-deltas.ts";

/**
 * A run's UI chunks replayed into its message, for saveReply (reply.ts), with the deltas
 * joined first (join-deltas.ts).
 *
 * A stream that fails to read, such as a durable stream whose read or reconnect fails,
 * rejects with that error after the replay, so the save writes nothing: a cut reply is
 * never saved as if it were whole. The save then fails as any failed save does: the run's
 * last step tries again, reading the stream from the start, and Stop and the sweep still
 * finish the run. The SDK's reader would swallow the error and keep what it had, and the
 * join would lose the deltas it held, so the read error is caught here, before both.
 *
 * An `error` chunk in the stream is not a read error: it is how a failed reply ends, and
 * that reply is saved.
 */
export async function replayReply(chunks: ReadableStream<UIMessageChunk>, base?: UIMessage): Promise<UIMessage | undefined> {
	const read = new ReadUntilError(chunks);
	let reply: UIMessage | undefined;
	for await (const message of readUIMessageStream({ message: base, stream: read.stream.pipeThrough(joinDeltas()) })) reply = message;
	if (read.failed) throw read.error;
	return reply;
}

/** The chunks until the source ends, or until a read fails: then the stream ends, and `error` holds why. */
export class ReadUntilError<T> {
	readonly stream: ReadableStream<T>;
	failed = false;
	error: unknown;

	constructor(source: ReadableStream<T>) {
		const reader = source.getReader();
		this.stream = new ReadableStream<T>({
			pull: async (controller) => {
				try {
					const { done, value } = await reader.read();
					if (done) controller.close();
					else controller.enqueue(value);
				} catch (error) {
					this.failed = true;
					this.error = error;
					// Closed, not errored, so the join releases what it holds (its flush) before the save sees the failure.
					controller.close();
				}
			},
			cancel: (reason) => reader.cancel(reason),
		});
	}
}
