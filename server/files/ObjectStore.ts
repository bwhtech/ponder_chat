import { AwsClient } from "aws4fetch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as PonderConfig from "../config.ts";

/**
 * Where the bytes of attached files go: an S3-compatible bucket (Cloudflare R2 when
 * deployed) when PONDER_S3_BUCKET is set, with PONDER_S3_ENDPOINT, PONDER_S3_ACCESS_KEY_ID
 * and PONDER_S3_SECRET_ACCESS_KEY. Without it, files.ts keeps the bytes in Postgres.
 *
 * For R2 the endpoint is https://<account id>.r2.cloudflarestorage.com and the keys
 * come from an R2 API token.
 *
 * aws4fetch signs each request and sends it with fetch, with its own retries of an answer
 * of 5xx or 429 (up to 10, with a growing wait), as before. Effect.tryPromise gives it the
 * signal, so an interrupted effect stops the request.
 */

/**
 * The bucket did not take or give a file: its HTTP status, or none when it could not be
 * reached (the cause). Not the bucket's answer, which can name the file's key.
 */
export class ObjectStoreError extends Schema.TaggedError<ObjectStoreError>()("ObjectStoreError", {
	operation: Schema.Literals(["put", "get", "delete"]),
	status: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect()),
}) {
	override get message() {
		const what = { put: "stored", get: "read", delete: "deleted" }[this.operation];
		return this.status === undefined ? `The file could not be ${what}.` : `The file could not be ${what} (${this.status}).`;
	}
}

export class ObjectStore extends Context.Service<
	ObjectStore,
	{
		/** Whether a bucket is set up. Without one, files.ts keeps the bytes in Postgres, and put and get are not called. */
		readonly enabled: boolean;
		readonly put: (key: string, data: Uint8Array, contentType: string) => Effect.Effect<void, ObjectStoreError>;
		/** The object's bytes, or none when it is not there. */
		readonly get: (key: string) => Effect.Effect<Option.Option<Buffer>, ObjectStoreError>;
		/** Deletes the object. One that is not there is no error. */
		readonly remove: (key: string) => Effect.Effect<void, ObjectStoreError>;
	}
>()("ponder/files/ObjectStore") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const store = Option.map(config.objectStore, (settings) => ({
		settings,
		client: new AwsClient({
			accessKeyId: settings.accessKeyId,
			secretAccessKey: Redacted.value(settings.secretAccessKey),
			service: "s3",
			// R2 takes "auto"; MinIO and others take any region.
			region: settings.region,
		}),
	}));

	// files.ts asks only when `enabled`: a call without a bucket is a bug.
	const bucket = Option.match(store, { onNone: () => Effect.die(new Error("No bucket is set up (PONDER_S3_BUCKET).")), onSome: Effect.succeed });
	const urlOf = ({ settings }: { settings: { endpoint: string; bucket: string } }, key: string) =>
		`${settings.endpoint}/${settings.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

	const put = Effect.fn("ObjectStore.put")(function* (key: string, data: Uint8Array, contentType: string) {
		const found = yield* bucket;
		const response = yield* Effect.tryPromise({
			try: (signal) => found.client.fetch(urlOf(found, key), { method: "PUT", body: Uint8Array.from(data), headers: { "Content-Type": contentType }, signal }),
			catch: (cause) => new ObjectStoreError({ operation: "put", cause }),
		});
		if (!response.ok) {
			yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
			return yield* new ObjectStoreError({ operation: "put", status: response.status });
		}
	});

	const get = Effect.fn("ObjectStore.get")(function* (key: string) {
		const found = yield* bucket;
		const failed = (cause: unknown) => new ObjectStoreError({ operation: "get", cause });
		const response = yield* Effect.tryPromise({ try: (signal) => found.client.fetch(urlOf(found, key), { signal }), catch: failed });
		if (response.status === 404) return Option.none<Buffer>();
		if (!response.ok) return yield* new ObjectStoreError({ operation: "get", status: response.status });
		return Option.some(Buffer.from(yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: failed })));
	});

	const remove = Effect.fn("ObjectStore.remove")(function* (key: string) {
		const found = yield* bucket;
		const response = yield* Effect.tryPromise({
			try: (signal) => found.client.fetch(urlOf(found, key), { method: "DELETE", signal }),
			catch: (cause) => new ObjectStoreError({ operation: "delete", cause }),
		});
		yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve());
		// S3 answers 204 for a key that is not there too.
		if (!response.ok && response.status !== 404) return yield* new ObjectStoreError({ operation: "delete", status: response.status });
	});

	return ObjectStore.of({ enabled: Option.isSome(store), put, get, remove });
});

export const layer = Layer.effect(ObjectStore, make);
