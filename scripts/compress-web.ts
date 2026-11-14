/**
 * Writes a brotli (.br) and a gzip (.gz) copy beside each text file of the web build, at the
 * highest levels, for the server to send as they are (serveStatic's `precompressed` in
 * server/app.ts). Cloudflare compresses on the fly at a low level: the chat's stylesheet was
 * 68 KB that way, and is 48 KB at brotli's level 11. `npm run build` runs it after Vite.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = "dist";
const TEXT = /\.(js|css|svg|json|webmanifest|txt|html)$/;

let files = 0;
let before = 0;
let after = 0;
for (const path of walk(ROOT)) {
	if (!TEXT.test(path)) continue;
	const data = readFileSync(path);
	// Too small to gain from it.
	if (data.length < 1024) continue;
	const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
	writeFileSync(`${path}.br`, br);
	writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
	files++;
	before += data.length;
	after += br.length;
}
console.log(`compress-web: ${files} files, ${Math.round(before / 1024)} KB, ${Math.round(after / 1024)} KB with brotli`);

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}
