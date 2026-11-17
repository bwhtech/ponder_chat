/**
 * Makes picture-pages.pdf, the small PDF that the reader's tests use:
 *   1. a text page,
 *   2. a page with a caption in text and a picture of a dose table (about 30% of the page),
 *   3. a scan: one picture over the whole page, with no text.
 * The pictures are drawn by ImageMagick (`magick`), so only this script needs it.
 * Run: node server/workspaces/documents/fixtures/make-fixture.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const TABLE = { width: 800, height: 320 };
const SCAN = { width: 640, height: 832 };

const table = picture(TABLE, [
	"-pointsize", "26", "-annotate", "+20+40", "Table 5. Intraperitoneal antibiotic doses",
	"-pointsize", "22",
	"-annotate", "+20+100", "Drug", "-annotate", "+250+100", "Intermittent (daily)", "-annotate", "+530+100", "Continuous",
	"-annotate", "+20+160", "Cefazolin", "-annotate", "+250+160", "15 mg/kg daily", "-annotate", "+530+160", "LD 500 mg/L",
	"-annotate", "+20+220", "Gentamicin", "-annotate", "+250+220", "0.6 mg/kg daily", "-annotate", "+530+220", "LD 8 mg/L",
	"-annotate", "+20+280", "Vancomycin", "-annotate", "+250+280", "30 mg/kg every 5 days", "-annotate", "+530+280", "LD 30 mg/kg",
	"-draw", "line 10,115 790,115", "-draw", "line 10,175 790,175", "-draw", "line 10,235 790,235",
]);
const scan = picture(SCAN, [
	"-pointsize", "30", "-annotate", "+40+120", "Exit site care",
	"-pointsize", "24", "-annotate", "+40+190", "Clean the exit site every second day.", "-annotate", "+40+240", "Use sterile gauze and saline.",
]);

const text = (lines: string[]) => lines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 72 ${720 - index * 24} Td (${line}) Tj ET`).join("\n");

const pdf = buildPdf([
	{
		content: text([
			"1. Peritoneal dialysis",
			"Peritonitis is the main infection of peritoneal dialysis.",
			"A cloudy bag with abdominal pain is peritonitis until proven otherwise.",
			"Send the effluent for cell count and culture before the first dose.",
		]),
	},
	{ content: `${text(["Doses for peritonitis"])}\nq 500 0 0 200 56 420 cm /Im1 Do Q`, image: table },
	{ content: "q 612 0 0 792 0 0 cm /Im1 Do Q", image: scan },
]);
writeFileSync(new URL("./picture-pages.pdf", import.meta.url), pdf);
console.log(`picture-pages.pdf: ${pdf.length} bytes`);

/** A 1-bit picture, black on white. Widths are multiples of 8, so each row fills whole bytes. */
function picture(size: { width: number; height: number }, draw: string[]) {
	const args = ["-size", `${size.width}x${size.height}`, "xc:white", "-font", "Helvetica", "-fill", "black", ...draw, "-monochrome", "-depth", "1", "gray:-"];
	return { ...size, bits: execFileSync("magick", args) };
}

type Page = { content: string; image?: { width: number; height: number; bits: Buffer } };

function buildPdf(pages: Page[]) {
	const objects: Buffer[] = [];
	const add = (body: Buffer | string) => objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body) + 2;
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids = pages.map((page) => {
		const resources = [`/Font << /F1 ${font} 0 R >>`];
		if (page.image) resources.push(`/XObject << /Im1 ${add(imageObject(page.image))} 0 R >>`);
		const content = add(stream("", Buffer.from(page.content, "latin1")));
		return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources.join(" ")} >> /Contents ${content} 0 R >>`);
	});
	// Objects 1 and 2 are the catalog and the page tree; the others were numbered from 3.
	const all = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from(`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`), ...objects];
	const parts = [Buffer.from("%PDF-1.7\n")];
	const offsets: number[] = [];
	let length = parts[0].length;
	all.forEach((body, index) => {
		const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
		offsets.push(length);
		length += part.length;
		parts.push(part);
	});
	const xref = [`xref\n0 ${all.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)].join("");
	parts.push(Buffer.from(`${xref}trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
	return Buffer.concat(parts);
}

function imageObject(image: { width: number; height: number; bits: Buffer }) {
	const entries = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode`;
	return stream(entries, deflateSync(image.bits, { level: 9 }));
}

function stream(entries: string, data: Buffer) {
	return Buffer.concat([Buffer.from(`<< ${entries} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
}
