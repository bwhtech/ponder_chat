import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import sharp from "sharp";

/**
 * The organisation's own logo, which admins set in Settings, Branding: one for light mode
 * and one for dark mode, in `branding_logos`. Without one the app shows Ponder's own
 * (web/public/logo-light.svg and logo-dark.svg). Dark mode without its own logo shows the
 * light one, so one upload brands both.
 *
 * Every page asks which logos there are (the chat page's boot data, GET /api/brand), so they
 * are kept in memory. A change from /admin shows at once in this process.
 */

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(theme: string): theme is Theme {
	return (THEMES as readonly string[]).includes(theme);
}

/** For each theme, the version of its logo (when it was saved, in ms), or null for Ponder's own. */
export type LogoVersions = Record<Theme, number | null>;

export type Logo = { data: Buffer; mediaType: string; version: number };

/** Uploads larger than this are refused before they are read (admin/routes.ts) and here. */
export const MAX_LOGO_BYTES = 1024 * 1024;
/** A raster logo is stored at most this wide and high: the largest place it shows is 44px, on a 3x screen. */
const MAX_SIDE = 512;
const RASTER = new Set(["png", "jpeg", "webp", "gif"]);

/** The upload is not an image we take, or is too large. */
export class LogoRefused extends Schema.TaggedError<LogoRefused>()("LogoRefused", { reason: Schema.Literals(["not-image", "too-large"]) }) {
	override get message() {
		return this.reason === "too-large" ? "The logo is larger than 1 MB." : "The logo can't be read. Upload an SVG, PNG, JPEG or WebP image.";
	}
}

const LogoRow = Schema.Struct({
	theme: Schema.Literals(THEMES),
	data: Schema.Uint8Array,
	media_type: Schema.String,
	updated_at: Schema.Date,
});

export class Branding extends Context.Service<
	Branding,
	{
		/** Creates the table. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** Which logos an admin set. */
		readonly versions: Effect.Effect<LogoVersions, SqlError>;
		/** The logo an admin set for this theme, or none. */
		readonly logo: (theme: Theme) => Effect.Effect<Option.Option<Logo>, SqlError>;
		/** Checks the upload, makes a raster image smaller, and stores it. */
		readonly save: (theme: Theme, upload: Buffer, by: string) => Effect.Effect<Logo, SqlError | LogoRefused>;
		/** Back to Ponder's logo for this theme. False when there was none to remove. */
		readonly remove: (theme: Theme) => Effect.Effect<boolean, SqlError>;
	}
>()("ponder/branding/Branding") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	// The logos in memory, and a count of the changes made in this process. A read keeps its rows
	// only if no change came while it ran: else it could put back a logo just replaced or removed.
	const cached = yield* Ref.make({ changes: 0, logos: Option.none<Map<Theme, Logo>>() });

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists branding_logos (
				theme text primary key check (theme in ('light', 'dark')),
				data bytea not null,
				media_type text not null,
				updated_by text,
				updated_at timestamptz not null default now()
			)`;
	});

	const findAll = SqlSchema.findAll({
		Request: Schema.Void,
		Result: LogoRow,
		execute: () => sql`select theme, data, media_type, updated_at from branding_logos`,
	});

	// The rows are two at most, each a small image: all of them stay in memory until one changes.
	const all = Effect.gen(function* () {
		const known = yield* Ref.get(cached);
		if (Option.isSome(known.logos)) return known.logos.value;
		const rows = yield* findAll(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		const logos = new Map(rows.map((row) => [row.theme, { data: Buffer.from(row.data), mediaType: row.media_type, version: row.updated_at.getTime() }] as const));
		yield* Ref.update(cached, (now) => (now.changes === known.changes ? { changes: now.changes, logos: Option.some(logos) } : now));
		return logos;
	});

	const forget = Ref.update(cached, (now) => ({ changes: now.changes + 1, logos: Option.none<Map<Theme, Logo>>() }));

	const versions = Effect.map(all, (logos): LogoVersions => ({ light: logos.get("light")?.version ?? null, dark: logos.get("dark")?.version ?? null }));

	const logo = (theme: Theme) => Effect.map(all, (logos) => Option.fromUndefinedOr(logos.get(theme)));

	const save = Effect.fn("Branding.save")(function* (theme: Theme, upload: Buffer, by: string) {
		const image = yield* prepareLogo(upload);
		const [row] = yield* sql<{ updated_at: Date }>`
			insert into branding_logos (theme, data, media_type, updated_by, updated_at)
			values (${theme}, ${image.data}, ${image.mediaType}, ${by}, now())
			on conflict (theme) do update set data = excluded.data, media_type = excluded.media_type, updated_by = excluded.updated_by, updated_at = excluded.updated_at
			returning updated_at`;
		yield* forget;
		return { ...image, version: row.updated_at.getTime() } satisfies Logo;
	});

	const remove = Effect.fn("Branding.remove")(function* (theme: Theme) {
		const rows = yield* sql`delete from branding_logos where theme = ${theme} returning theme`;
		yield* forget;
		return rows.length > 0;
	});

	return Branding.of({ migrate, versions, logo, save, remove });
});

export const layer = Layer.effect(Branding, make);

/**
 * An SVG is kept as it is: it stays sharp at every size. Pages show it only in <img>, where
 * its scripts never run, and GET /api/brand/logo sends it with a policy that blocks them
 * when it is opened on its own. A PNG, JPEG, WebP or GIF becomes a PNG of at most 512px,
 * which also drops its metadata. sharp reads both, so bytes it can't read are refused.
 */
export const prepareLogo = Effect.fn("Branding.prepare")(function* (upload: Buffer) {
	if (upload.length > MAX_LOGO_BYTES) return yield* new LogoRefused({ reason: "too-large" });
	const meta = yield* Effect.tryPromise(() => sharp(upload, { failOn: "error" }).metadata()).pipe(Effect.option);
	const format = Option.isSome(meta) ? meta.value.format : undefined;
	if (format === "svg") return { data: upload, mediaType: "image/svg+xml" };
	if (!format || !RASTER.has(format)) return yield* new LogoRefused({ reason: "not-image" });
	const resized = sharp(upload, { failOn: "error" }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
	// It was read just now, so a failure to encode it again is a bug.
	return { data: yield* Effect.promise(() => resized.png({ compressionLevel: 9 }).toBuffer()), mediaType: "image/png" };
});
