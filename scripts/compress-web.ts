/**
 * Writes a brotli (.br) and a gzip (.gz) copy beside each text file of the web build, at the
 * highest levels, for the server to send as they are (serveStatic's `precompressed` in
 * server/app.ts). Cloudflare compresses on the fly at a low level: the chat's stylesheet was
 * 68 KB that way, and is 48 KB at brotli's level 11. `npm run build` runs it after Vite.
 */
import { readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

const ROOT = "dist";
const TEXT = /\.(js|css|svg|json|webmanifest|txt|html)$/;

let files = 0;
let before = 0;
let after = 0;
// All files at once: zlib compresses on Node's thread pool, so the files share the machine's cores. The output is the same.
await Promise.all(
	[...walk(ROOT)].filter((path) => TEXT.test(path)).map(async (path) => {
		const data = await readFile(path);
		// Too small to gain from it.
		if (data.length < 1024) return;
		const [br, gz] = await Promise.all([
			brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
			gzipped(data, { level: 9 }),
		]);
		await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gz)]);
		files++;
		before += data.length;
		after += br.length;
	}),
);
console.log(`compress-web: ${files} files, ${Math.round(before / 1024)} KB, ${Math.round(after / 1024)} KB with brotli`);

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}
