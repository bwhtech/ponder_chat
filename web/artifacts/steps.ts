/**
 * What a reply has written of an artifact so far, as steps the card lists while it streams:
 * a deck's look (its <style>), then each slide by its heading; a document's sections by
 * their headings. The last step is the one being written, unless the artifact is finished.
 */
export type ArtifactStep = { key: string; label: string; done: boolean };

export function artifactSteps(kind: "document" | "slides", content: string, finished: boolean): ArtifactStep[] {
	const steps = kind === "slides" ? slideSteps(content) : documentSteps(content);
	return finished ? steps.map((step) => ({ ...step, done: true })) : steps;
}

function slideSteps(html: string): ArtifactStep[] {
	const steps: ArtifactStep[] = [];
	const style = html.search(/<style\b/i);
	const firstSlide = html.search(/<section\b/i);
	if (style !== -1 && (firstSlide === -1 || style < firstSlide)) {
		steps.push({ key: "look", label: "Set up the look", done: /<\/style>/i.test(html) });
	}
	const starts = [...html.matchAll(/<section\b/gi)].map((match) => match.index);
	starts.forEach((start, index) => {
		const slide = html.slice(start, starts[index + 1] ?? html.length);
		const heading = headingText(slide.match(/<h[1-3]\b[^>]*>([\s\S]*?)(?:<\/h[1-3]>|$)/i)?.[1] ?? "");
		const number = index + 1;
		steps.push({ key: `slide-${number}`, label: heading ? `Slide ${number} · ${heading}` : `Slide ${number}`, done: /<\/section>/i.test(slide) });
	});
	return steps;
}

function documentSteps(markdown: string): ArtifactStep[] {
	const headings = [...markdown.matchAll(/^#{1,3}[ \t]+(.+)$/gm)].map((match) => plainText(match[1]!));
	return headings.map((label, index) => ({ key: `section-${index}`, label, done: index < headings.length - 1 }));
}

/** A heading's text: tags dropped, entities read, spaces joined. A tag still being written is dropped too. */
function headingText(html: string) {
	const text = html.replace(/<[^>]*(>|$)/g, " ");
	return plainText(new DOMParser().parseFromString(`<!doctype html><html><body>${text}</body></html>`, "text/html").body.textContent ?? "");
}

function plainText(text: string) {
	return text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
}

/** "Writing slide 4…": what the card's second line says while a reply writes the artifact. */
export function currentStepText(kind: "document" | "slides", steps: ArtifactStep[]) {
	const current = steps.at(-1);
	if (!current || current.done) return kind === "slides" ? "Writing slides…" : "Writing document…";
	if (current.key === "look") return "Setting up the look…";
	return kind === "slides" ? `Writing ${current.label.split(" · ")[0]!.toLowerCase()}…` : `Writing “${current.label}”…`;
}
