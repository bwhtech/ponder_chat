/**
 * Attached files on a real Postgres (TEST_DATABASE_URL), with no bucket, so the bytes are
 * in the table. Files are private to their owner, and an upload that can't be used is
 * refused with its reason.
 */
import { randomUUID } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PonderConfig from "./config.ts";
import * as ObjectStore from "./files/ObjectStore.ts";
import * as Files from "./files.ts";
import * as PdfText from "./pdf-text.ts";
import * as Database from "./runtime/Database.ts";
import * as Settings from "./settings/Settings.ts";

const url = process.env.TEST_DATABASE_URL;
const layer = Files.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Settings.layer, ObjectStore.layer, PdfText.layer)),
	Layer.provideMerge(Database.layer),
	// Python is off: spreadsheets are refused.
	Layer.provide(PonderConfig.layerFromEnv({ ...(url ? { DATABASE_URL: url } : {}), PONDER_PYTHON: "off" })),
);

const owner = () => `files-test-${randomUUID()}`;
const refusal = (effect: Effect.Effect<unknown, Files.FileRefused | unknown>) =>
	Effect.flip(effect).pipe(Effect.map((error) => (error instanceof Files.FileRefused ? error.reason : "other")));

describe.skipIf(!url)("Files", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		it.effect("migrates twice", () =>
			Effect.gen(function* () {
				const files = yield* Files.Files;
				yield* Settings.Settings.use((settings) => settings.migrate);
				yield* files.migrate;
				yield* files.migrate;
			}),
		);

		it.effect("gives a file back only to its owner", () =>
			Effect.gen(function* () {
				const files = yield* Files.Files;
				const [mine, theirs] = [owner(), owner()];
				const data = Buffer.from([0, 1, 2, 250, 255]);
				const stored = yield* files.store(mine, "bytes.bin", "application/octet-stream", data);
				assert.strictEqual(stored.url, `/api/files/${stored.id}`);
				assert.strictEqual(stored.size, 5);

				const loaded = Option.getOrThrow(yield* files.load(stored.id, mine));
				assert.deepStrictEqual([...loaded.data], [...data]);
				assert.strictEqual(loaded.name, "bytes.bin");
				assert.strictEqual(loaded.text, null);
				assert.isTrue(Option.isNone(yield* files.load(stored.id, theirs)));
				assert.isTrue(Option.isNone(yield* files.load("no-such-file", mine)));
			}),
		);

		it.effect("takes a text file as it is, by its extension", () =>
			Effect.gen(function* () {
				const files = yield* Files.Files;
				const person = owner();
				const stored = yield* files.save(person, new File(["a,b\n1,2\n"], "table.csv"));
				assert.strictEqual(stored.mediaType, "text/csv");
				const loaded = Option.getOrThrow(yield* files.load(stored.id, person));
				assert.strictEqual(loaded.data.toString("utf8"), "a,b\n1,2\n");
			}),
		);

		it.effect("refuses what it can't use, and says why", () =>
			Effect.gen(function* () {
				const files = yield* Files.Files;
				const person = owner();
				assert.strictEqual(yield* refusal(files.save(person, new File(["x"], "sheet.xlsx"))), "spreadsheet");
				assert.strictEqual(yield* refusal(files.save(person, new File([new Uint8Array(Files.MAX_FILE_BYTES + 1)], "big.txt"))), "too-large");
				assert.strictEqual(yield* refusal(files.save(person, new File(["x"], "program.exe"))), "unknown-type");
				assert.strictEqual(yield* refusal(files.save(person, new File(["not a pdf"], "paper.pdf", { type: "application/pdf" }))), "not-pdf");
				assert.strictEqual(yield* refusal(files.save(person, new File(["not an image"], "photo.png", { type: "image/png" }))), "not-image");
				assert.strictEqual(Files.refusalText("big.txt", new Files.FileRefused({ reason: "too-large" })), `"big.txt" is larger than 10 MB.`);
			}),
		);

		it.effect("keeps a PDF's text once read", () =>
			Effect.gen(function* () {
				const files = yield* Files.Files;
				const sql = yield* PgClient.PgClient;
				const person = owner();
				const stored = yield* files.store(person, "paper.pdf", "application/pdf", Buffer.from("%PDF-1.7"));
				yield* sql`update files set text = ${"Read before."} where id = ${stored.id}`;
				const loaded = Option.getOrThrow(yield* files.load(stored.id, person));
				// Kept: the PDF is not read again.
				assert.strictEqual(yield* files.pdfText(stored.id, loaded), "Read before.");
				yield* sql`delete from files where owner like 'files-test-%'`;
			}),
		);
	});
});
