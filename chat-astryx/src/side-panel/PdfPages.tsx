import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useRef, useState } from "react";
import NotShown from "./NotShown";

/**
 * Every page of a PDF in one column that scrolls. A page draws when it comes
 * near the screen, so a long PDF does not draw all its pages at once.
 * This file and pdf.js load only when the side panel first opens a PDF.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

/** `tries` counts failed draws: a page gets one more try, then shows that it failed. */
type Page = { number: number; ratio: number; drawn: boolean; tries: number; failed: boolean };

export default function PdfPages({ url, name }: { url: string; name: string }) {
	const [pages, setPages] = useState<Page[]>([]);
	const [failed, setFailed] = useState(false);
	const observer = useRef<IntersectionObserver | null>(null);

	useEffect(() => {
		let unmounted = false;
		let document: PDFDocumentProxy | undefined;
		const task = getDocument({ url });
		const drawing = new Set<number>();
		// The pages as the observer's callback reads them; React state follows.
		let current: Page[] = [];
		const change = (number: number, patch: Partial<Page>) => {
			current = current.map((page) => (page.number === number ? { ...page, ...patch } : page));
			if (!unmounted) setPages(current);
		};

		async function draw(number: number, element: HTMLElement) {
			const canvas = element.querySelector("canvas");
			if (!document || !canvas || drawing.has(number)) return;
			drawing.add(number);
			try {
				const page = await document.getPage(number);
				const base = page.getViewport({ scale: 1 });
				// Sharp on high-density screens: draw at the element's width in device pixels.
				const scale = (element.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width;
				const viewport = page.getViewport({ scale });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				await page.render({ canvas, viewport }).promise;
				change(number, { ratio: base.width / base.height, drawn: true });
			} catch {
				// The others still show. Watch the page again for one more try, then show it failed.
				const tries = (current[number - 1]?.tries ?? 0) + 1;
				change(number, tries < 2 ? { tries } : { tries, failed: true });
				if (tries < 2) observer.current?.observe(element);
			} finally {
				drawing.delete(number);
			}
		}

		function onVisible(entries: IntersectionObserverEntry[]) {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const target = entry.target as HTMLElement;
				observer.current?.unobserve(target);
				const number = Number(target.dataset.page);
				const page = current[number - 1];
				if (page && !page.drawn && !page.failed) void draw(number, target);
			}
		}

		void (async () => {
			try {
				const loaded = await task.promise;
				const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
				// The viewer closed while the PDF loaded: watch nothing.
				if (unmounted) return;
				document = loaded;
				observer.current = new IntersectionObserver(onVisible, { rootMargin: "100% 0px" });
				// Until a page draws, it has the shape of the first page.
				current = Array.from({ length: loaded.numPages }, (_, index) => ({
					number: index + 1,
					ratio: first.width / first.height,
					drawn: false,
					tries: 0,
					failed: false,
				}));
				setPages(current);
			} catch {
				if (!unmounted) setFailed(true);
			}
		})();

		return () => {
			unmounted = true;
			observer.current?.disconnect();
			observer.current = null;
			void task.destroy();
		};
	}, [url]);

	/** Each page element calls this as it mounts, so the observer can watch it. */
	const watchPage = useCallback((element: HTMLDivElement | null) => {
		if (element) observer.current?.observe(element);
	}, []);

	if (failed) return <NotShown title="This PDF could not be shown." url={url} name={name} />;

	return (
		<div data-slot="pdf-pages" className="flex min-h-full flex-col items-center gap-3 p-3 pb-8 sm:p-6" aria-live="polite">
			{pages.length ? (
				pages.map((page) => (
					<div
						key={page.number}
						ref={watchPage}
						data-page={page.number}
						role="img"
						aria-label={`Page ${page.number} of ${pages.length}`}
						className="w-full max-w-[860px] overflow-hidden rounded-lg border border-border bg-surface shadow-sm"
					>
						<AspectRatio ratio={page.ratio}>
							<canvas className="block size-full" />
							{page.failed ? (
								<div className="absolute inset-0 flex items-center justify-center bg-muted p-4 text-center">
									<Text color="secondary">Page {page.number} could not be shown.</Text>
								</div>
							) : (
								!page.drawn && (
									<div className="absolute inset-0">
										<Skeleton radius="none" />
									</div>
								)
							)}
						</AspectRatio>
					</div>
				))
			) : (
				// Loading: a page-shaped placeholder.
				<div className="w-full max-w-[860px]">
					<AspectRatio ratio={1 / 1.414}>
						<Skeleton radius={3} />
					</AspectRatio>
				</div>
			)}
		</div>
	);
}
