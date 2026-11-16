/**
 * The organisation's logo. `prepareLogo` needs nothing; the table runs on a real Postgres
 * (TEST_DATABASE_URL, vitest.config.ts). The table holds one logo per theme for the whole
 * database, so the test keeps what it found and puts it back at the end.
 */
import { assert, describe, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import sharp from "sharp";
import * as PonderConfig from "../config.ts";
import * as Database from "../runtime/Database.ts";
import * as Branding from "./Branding.ts";

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#123456"/></svg>');
const bigPng = () => Effect.promise(() => sharp({ create: { width: 2000, height: 1000, channels: 4, background: "#ff0000" } }).jpeg().toBuffer());

/** The reason an upload was refused, or "other" for another failure. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect).pipe(Effect.map((error) => (error instanceof Branding.LogoRefused ? error.reason : "other")));

describe("prepareLogo", () => {
	it.effect("keeps an SVG as it is", () =>
		Effect.gen(function* () {
			const logo = yield* Branding.prepareLogo(SVG);
			assert.strictEqual(logo.mediaType, "image/svg+xml");
			assert.isTrue(logo.data.equals(SVG));
		}),
	);

	it.effect("makes a large raster image a PNG of at most 512px", () =>
		Effect.gen(function* () {
			const logo = yield* Branding.prepareLogo(yield* bigPng());
			assert.strictEqual(logo.mediaType, "image/png");
			const meta = yield* Effect.promise(() => sharp(logo.data).metadata());
			assert.deepStrictEqual([meta.format, meta.width, meta.height], ["png", 512, 256]);
		}),
	);

	it.effect("refuses what is not an image, and what is over 1 MB", () =>
		Effect.gen(function* () {
			assert.strictEqual(yield* refusal(Branding.prepareLogo(Buffer.from("<html><script>alert(1)</script></html>"))), "not-image");
			assert.strictEqual(yield* refusal(Branding.prepareLogo(Buffer.alloc(Branding.MAX_LOGO_BYTES + 1))), "too-large");
		}),
	);
});

const url = process.env.TEST_DATABASE_URL;
const layer = Branding.layer.pipe(Layer.provideMerge(Database.layer), Layer.provide(PonderConfig.layerFromEnv(url ? { DATABASE_URL: url } : {})));

describe.skipIf(!url)("Branding", () => {
	it.layer(layer, { excludeTestServices: true })((it) => {
		let found: readonly { theme: string; data: Uint8Array; media_type: string; updated_by: string | null; updated_at: Date }[] = [];

		it.effect("migrates twice, and starts with Ponder's logo", () =>
			Effect.gen(function* () {
				const branding = yield* Branding.Branding;
				const sql = yield* PgClient.PgClient;
				yield* branding.migrate;
				yield* branding.migrate;
				found = yield* sql<{ theme: string; data: Uint8Array; media_type: string; updated_by: string | null; updated_at: Date }>`select theme, data, media_type, updated_by, updated_at from branding_logos`;
				yield* sql`delete from branding_logos`;
				yield* branding.remove("light");
				assert.deepStrictEqual(yield* branding.versions, { light: null, dark: null });
				assert.isTrue(Option.isNone(yield* branding.logo("dark")));
			}),
		);

		it.effect("saves a logo per theme, shows it at once, and replaces it", () =>
			Effect.gen(function* () {
				const branding = yield* Branding.Branding;
				const light = yield* branding.save("light", SVG, "test-admin");
				const versions = yield* branding.versions;
				assert.deepStrictEqual(versions, { light: light.version, dark: null });
				const stored = yield* branding.logo("light");
				assert.isTrue(Option.isSome(stored) && stored.value.data.equals(SVG) && stored.value.mediaType === "image/svg+xml");

				const dark = yield* branding.save("dark", yield* bigPng(), "test-admin");
				assert.strictEqual(dark.mediaType, "image/png");
				const again = yield* branding.save("light", yield* bigPng(), "test-admin");
				assert.isAtLeast(again.version, light.version);
				assert.deepStrictEqual(yield* branding.versions, { light: again.version, dark: dark.version });
			}),
		);

		it.effect("refuses an upload that is not an image, and keeps the logo", () =>
			Effect.gen(function* () {
				const branding = yield* Branding.Branding;
				const before = yield* branding.versions;
				assert.strictEqual(yield* refusal(branding.save("light", Buffer.from("not an image"), "test-admin")), "not-image");
				assert.deepStrictEqual(yield* branding.versions, before);
			}),
		);

		it.effect("removes a logo once", () =>
			Effect.gen(function* () {
				const branding = yield* Branding.Branding;
				assert.isTrue(yield* branding.remove("dark"));
				assert.isFalse(yield* branding.remove("dark"));
				assert.strictEqual((yield* branding.versions).dark, null);
			}),
		);

		it.effect("puts the logos back", () =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient;
				yield* sql`delete from branding_logos`;
				for (const row of found) {
					yield* sql`insert into branding_logos (theme, data, media_type, updated_by, updated_at) values (${row.theme}, ${row.data}, ${row.media_type}, ${row.updated_by}, ${row.updated_at})`;
				}
			}),
		);
	});
});
