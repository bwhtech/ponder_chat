import sharp from "sharp";

/**
 * Attached images, checked and made smaller before they are stored. Models scale an
 * image down to about 1,568 pixels on its long side anyway, and a bigger one costs
 * more tokens on every call of the chat. Re-encoding also drops the photo's metadata,
 * such as where it was taken. GIFs are kept as they are, so animations still play.
 */
const MAX_SIDE = 1568;
const FORMATS: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The image to store and its real type, or undefined when the bytes are not an image we take. */
export async function prepareImage(data: Buffer): Promise<{ data: Buffer; mediaType: string } | undefined> {
	const image = sharp(data, { failOn: "error" });
	const meta = await image.metadata().catch(() => undefined);
	const mediaType = meta && FORMATS[meta.format];
	if (!meta || !mediaType) return undefined;

	const tooBig = Math.max(meta.width, meta.height) > MAX_SIDE;
	if (mediaType === "image/gif" || (!tooBig && !meta.exif)) return { data, mediaType };
	// rotate() turns the pixels as the camera's orientation tag says, before the tag is dropped.
	const resized = image.rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
	if (mediaType === "image/jpeg") return { data: await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), mediaType };
	if (mediaType === "image/webp") return { data: await resized.webp({ quality: 85 }).toBuffer(), mediaType };
	return { data: await resized.png({ compressionLevel: 9 }).toBuffer(), mediaType };
}
