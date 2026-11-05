import { AwsClient } from "aws4fetch";

/**
 * Where the bytes of attached files go: an S3-compatible bucket (Cloudflare R2 when
 * deployed) when PONDER_S3_BUCKET is set, with PONDER_S3_ENDPOINT, PONDER_S3_ACCESS_KEY_ID
 * and PONDER_S3_SECRET_ACCESS_KEY. Without it, files.ts keeps the bytes in Postgres.
 *
 * For R2 the endpoint is https://<account id>.r2.cloudflarestorage.com and the keys
 * come from an R2 API token.
 */
const bucket = process.env.PONDER_S3_BUCKET;
const endpoint = process.env.PONDER_S3_ENDPOINT?.replace(/\/$/, "");

const client =
	bucket && endpoint
		? new AwsClient({
				accessKeyId: process.env.PONDER_S3_ACCESS_KEY_ID ?? "",
				secretAccessKey: process.env.PONDER_S3_SECRET_ACCESS_KEY ?? "",
				service: "s3",
				// R2 takes "auto"; MinIO and others take any region.
				region: process.env.PONDER_S3_REGION ?? "auto",
			})
		: undefined;

export const objectStoreEnabled = Boolean(client);
export const objectStoreName = client ? `bucket ${bucket}` : "Postgres";

const urlOf = (key: string) => `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

export async function putObject(key: string, data: Uint8Array, contentType: string) {
	const response = await client!.fetch(urlOf(key), { method: "PUT", body: Uint8Array.from(data), headers: { "Content-Type": contentType } });
	if (!response.ok) throw new Error(`The file could not be stored (${response.status}): ${await response.text()}`);
}

/** The object's bytes, or undefined when it is not there. */
export async function getObject(key: string): Promise<Buffer | undefined> {
	const response = await client!.fetch(urlOf(key));
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
	return Buffer.from(await response.arrayBuffer());
}
