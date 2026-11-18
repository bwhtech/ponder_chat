import { deflateSync } from "node:zlib";

/**
 * PDFs made in code, for the tests and for server/pdf-text.check.ts. Most have no
 * cross-reference table: pdf.js finds the objects itself.
 */

/** A PDF with one page for each line, in Helvetica. */
export function textPdf(lines: string[]) {
	return pagesPdf(lines.map((line) => `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`));
}

/** A PDF with one page for each content stream. */
export function pagesPdf(contents: string[]) {
	const kids = contents.map((_, index) => `${10 + index * 2} 0 R`).join(" ");
	const objects = [object(1, "<< /Type /Catalog /Pages 2 0 R >>"), object(2, `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`), font()];
	contents.forEach((content, index) => {
		const page = 10 + index * 2;
		objects.push(object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents ${page + 1} 0 R >>`));
		objects.push(stream(page + 1, "", content));
	});
	return pdf(objects);
}

/**
 * A PDF of about 3 KB that takes pdf.js months to read: its page draws a form, which
 * draws the next form 10 times, and so on for `depth` levels down to a line of text.
 */
export function slowPdf(depth = 12) {
	const form = (level: number) => 10 + level;
	const objects = [
		object(1, "<< /Type /Catalog /Pages 2 0 R >>"),
		object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
		object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /X0 ${form(0)} 0 R >> >> /Contents 5 0 R >>`),
		font(),
		stream(5, "", "/X0 Do"),
	];
	for (let level = 0; level < depth - 1; level++) {
		const draws = Array.from({ length: 10 }, () => `/X${level + 1} Do`).join(" ");
		objects.push(stream(form(level), `/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /XObject << /X${level + 1} ${form(level + 1)} 0 R >> >>`, draws));
	}
	objects.push(stream(form(depth - 1), "/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >>", "BT /F1 12 Tf (Hello world) Tj ET"));
	return pdf(objects);
}

/**
 * A PDF of a line of text, then `scans` scans (one by default): pictures over the whole page
 * with no text, which a workspace document sends to the page model
 * (server/workspaces/documents/read-pdf.ts). The picture's bytes hold `key` as they are
 * (deflate with no compression), so the one-page PDF that reaches the fake model holds it
 * too, and a PageScript can match it. The scans share one picture.
 */
export function scanPdf(line: string, key: string, scans = 1) {
	const width = 640;
	const height = 832;
	const bits = Buffer.alloc((width / 8) * height, 0xff);
	bits.write(key, 4_000, "latin1");
	const image = deflateSync(bits, { level: 0 });
	const scan = "q 612 0 0 792 0 0 cm /Im1 Do Q";
	const text = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
	// 1 the catalog, 2 the page tree, 3 the text page, 4 the font, 5 its text, 6 the picture,
	// 7 a scan's drawing, and the scan pages from 8.
	const scanPages = Array.from({ length: scans }, (_, index) => 8 + index);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${[3, ...scanPages].map((page) => `${page} 0 R`).join(" ")}] /Count ${scans + 1} >>`,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		Buffer.concat([
			Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),
			image,
			Buffer.from("\nendstream"),
		]),
		`<< /Length ${scan.length} >>\nstream\n${scan}\nendstream`,
		...scanPages.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 6 0 R >> >> /Contents 7 0 R >>"),
	];
	return withXref(objects.map((body) => (typeof body === "string" ? Buffer.from(body, "latin1") : body)));
}

/** Objects numbered from 1, with a cross-reference table, as LiteParse wants. */
function withXref(objects: Buffer[]) {
	const parts = [Buffer.from("%PDF-1.7\n")];
	const offsets: number[] = [];
	let length = parts[0].length;
	objects.forEach((body, index) => {
		const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
		offsets.push(length);
		length += part.length;
		parts.push(part);
	});
	const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
	parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
	return Buffer.concat(parts);
}

function pdf(objects: string[]) {
	return Buffer.from(`%PDF-1.7\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF`);
}

function font() {
	return object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
}

function stream(number: number, entries: string, content: string) {
	return object(number, `<< ${entries} /Length ${content.length} >>\nstream\n${content}\nendstream`);
}

function object(number: number, body: string) {
	return `${number} 0 obj\n${body}\nendobj\n`;
}
