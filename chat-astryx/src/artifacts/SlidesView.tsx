import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Artifact } from "../side-panel/panel";
import { finishedSlides, framedDeck, SLIDE_GAP, SLIDE_HEIGHT, SLIDE_WIDTH, slideCount } from "./slides";
import { artifactSteps, currentStepText } from "./steps";

/**
 * A slide deck in the panel, every slide in one column. The frame is drawn at the slides'
 * own size and scaled to the panel's width, so the deck looks the same at any width.
 * While the reply writes it, a slide shows once it is finished.
 */
export default function SlidesView({ artifact }: { artifact: Artifact }) {
	const html = artifact.writing ? finishedSlides(artifact.content) : artifact.content;
	const count = slideCount(html);
	// A new page for the frame only when a slide is added, not on every streamed word.
	const page = useMemo(() => framedDeck(html), [html]);
	// "Writing slide 4…" or "Setting up the look…" on the placeholder for the slide on its way.
	const writingText = currentStepText("slides", artifactSteps("slides", artifact.content, false));
	const frameHeight = count * SLIDE_HEIGHT + Math.max(0, count - 1) * SLIDE_GAP;
	const column = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
		if (column.current) observer.observe(column.current);
		return () => observer.disconnect();
	}, []);
	const scale = width / SLIDE_WIDTH;

	// The frame's size follows the panel's width, so it goes in through CSS variables.
	const size = { "--slide-width": `${SLIDE_WIDTH}px`, "--frame-height": `${frameHeight}px`, "--scale": scale } as CSSProperties;
	return (
		// contentRect leaves out the padding, so the frame's width is the column's.
		<div ref={column} className="flex flex-col gap-4 p-4 sm:p-6">
			{count > 0 && scale > 0 && (
				<div className="relative h-[calc(var(--frame-height)*var(--scale))] overflow-hidden" style={size}>
					<iframe
						srcDoc={page}
						sandbox=""
						referrerPolicy="no-referrer"
						title={artifact.title}
						className="absolute left-0 top-0 h-(--frame-height) w-(--slide-width) origin-top-left scale-(--scale) border-0"
					/>
				</div>
			)}
			{artifact.writing ? (
				<AspectRatio ratio={16 / 9}>
					<Skeleton radius={3} />
					<div className="absolute inset-0 flex items-center justify-center">
						<Text type="supporting">{writingText}</Text>
					</div>
				</AspectRatio>
			) : (
				!count && (
					<div className="flex justify-center pt-[20vh]">
						<EmptyState title="This deck has no slides." />
					</div>
				)
			)}
		</div>
	);
}
