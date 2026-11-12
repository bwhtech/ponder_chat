/**
 * PDFs made in code, for the tests and for server/pdf-text.check.ts. They have no
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
