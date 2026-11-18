import * as Schema from "effect/Schema";

/**
 * What a prepare-text worker gets: prepare-text.ts sends it, and prepare-text-worker.ts
 * decodes it. A module of its own, with only Effect's Schema, so that the worker does not
 * import the server's code (prepare-text-worker.ts).
 */
export const PrepareJob = Schema.Union([
	/** A text document's bytes: its stored text and passages. */
	Schema.Struct({ kind: Schema.Literal("read"), name: Schema.String, mediaType: Schema.String, data: Schema.Uint8Array }),
	/** A stored text: its passages. */
	Schema.Struct({ kind: Schema.Literal("chunk"), name: Schema.String, mediaType: Schema.String, text: Schema.String }),
	/** A PDF's bytes: its pages (parse-pdf.ts). */
	Schema.Struct({ kind: Schema.Literal("parse-pdf"), data: Schema.Uint8Array }),
	/** A PDF's pages, with the model's text: its stored text and passages. */
	Schema.Struct({
		kind: Schema.Literal("pdf"),
		name: Schema.String,
		pages: Schema.Array(Schema.Struct({ page: Schema.NullOr(Schema.Number), markdown: Schema.String })),
	}),
]);
export type PrepareJob = typeof PrepareJob.Type;
