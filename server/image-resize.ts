import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import sharp from "sharp";

/**
 * Attached images, checked and made smaller before they are stored. Models scale an
 * image down to about 1,568 pixels on its long side anyway, and a bigger one costs
 * more tokens on every call of the chat. Re-encoding also drops the photo's metadata,
 * such as where it was taken. GIFs are kept as they are, so animations still play.
 *
 * sharp works on libuv's threads, not the server's own. Bytes it can't read are no image
 * we take (none); an image it read but can't encode again is a bug, a defect.
 */
const MAX_SIDE = 1568;
const FORMATS: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export type PreparedImage = { data: Buffer; mediaType: string };

/** The image to store and its real type, or none when the bytes are not an image we take. */
export const prepareImage = Effect.fn("Images.prepare")(function* (data: Buffer) {
	const image = sharp(data, { failOn: "error" });
	const meta = yield* Effect.tryPromise(() => image.metadata()).pipe(Effect.option);
	const mediaType = Option.isSome(meta) ? FORMATS[meta.value.format] : undefined;
	if (Option.isNone(meta) || !mediaType) return Option.none<PreparedImage>();
	const { width, height, exif } = meta.value;

	const tooBig = Math.max(width, height) > MAX_SIDE;
	if (mediaType === "image/gif" || (!tooBig && !exif)) return Option.some<PreparedImage>({ data, mediaType });
	// rotate() turns the pixels as the camera's orientation tag says, before the tag is dropped.
	const resized = image.rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
	const encoded =
		mediaType === "image/jpeg"
			? resized.jpeg({ quality: 85, mozjpeg: true })
			: mediaType === "image/webp"
				? resized.webp({ quality: 85 })
				: resized.png({ compressionLevel: 9 });
	return Option.some<PreparedImage>({ data: yield* Effect.promise(() => encoded.toBuffer()), mediaType });
});
