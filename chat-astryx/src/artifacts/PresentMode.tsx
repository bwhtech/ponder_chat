import { Dialog } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { Artifact } from "../side-panel/panel";
import { presentedDeck, SLIDE_HEIGHT, SLIDE_WIDTH, slideCount } from "./slides";

/**
 * A deck full screen, one slide at a time. The frame holds every slide and moves to show
 * the current one, so a slide change does not reload it. Arrow keys, Space, Page Up/Down
 * or a click move; Escape leaves. Where the browser has no full screen (iPhone), it covers the page.
 * It is a dark dialog, so it sits above the panel even where the panel is a dialog itself.
 */
type Props = { artifact: Artifact; onClose: () => void };

const MOVES: Record<string, number> = {
	ArrowRight: 1,
	ArrowDown: 1,
	PageDown: 1,
	" ": 1,
	Enter: 1,
	ArrowLeft: -1,
	ArrowUp: -1,
	PageUp: -1,
	Backspace: -1,
};

export default function PresentMode({ artifact, onClose }: Props) {
	const root = useRef<HTMLDivElement>(null);
	const page = useMemo(() => presentedDeck(artifact.content), [artifact.content]);
	const count = slideCount(artifact.content);
	const [index, setIndex] = useState(0);
	const viewport = useViewport();
	const scale = Math.min(viewport.width / SLIDE_WIDTH, viewport.height / SLIDE_HEIGHT);
	const controls = useControls();

	const go = useCallback((to: number) => setIndex(Math.min(Math.max(0, to), count - 1)), [count]);
	const leave = useCallback(() => {
		if (document.fullscreenElement) void document.exitFullscreen();
		else onClose();
	}, [onClose]);

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (event.key === "Escape") leave();
			else if (event.key === "Home") go(0);
			else if (event.key === "End") go(count - 1);
			else if (event.key in MOVES) setIndex((at) => Math.min(Math.max(0, at + MOVES[event.key]!), count - 1));
			else return;
			// The slides own these keys: the chat behind must not get them (Enter would send a message).
			event.preventDefault();
			event.stopPropagation();
		}
		addEventListener("keydown", onKeydown, { capture: true });
		return () => removeEventListener("keydown", onKeydown, { capture: true });
	}, [count, go, leave]);

	// Full screen where the browser has it. Leaving it with the browser's own key also leaves present mode.
	useEffect(() => {
		(document.activeElement as HTMLElement | null)?.blur();
		const onFullscreenChange = () => !document.fullscreenElement && onClose();
		root.current
			?.requestFullscreen?.()
			.then(() => document.addEventListener("fullscreenchange", onFullscreenChange))
			.catch(() => undefined);
		return () => {
			document.removeEventListener("fullscreenchange", onFullscreenChange);
			if (document.fullscreenElement) void document.exitFullscreen();
		};
	}, [onClose]);

	/** A click on the left third goes back; anywhere else goes on. */
	function onClick(event: MouseEvent) {
		go(index + (event.clientX < innerWidth / 3 ? -1 : 1));
	}

	// The slide's size follows the screen, so it goes in through CSS variables.
	const size = {
		"--slide-width": `${SLIDE_WIDTH}px`,
		"--slide-height": `${SLIDE_HEIGHT}px`,
		"--deck-height": `${SLIDE_HEIGHT * count}px`,
		"--scale": scale,
		"--shift": `${-index * SLIDE_HEIGHT}px`,
	} as CSSProperties;

	return (
		<Dialog isOpen onOpenChange={(open) => !open && onClose()} variant="fullscreen" padding={0} aria-label={`${artifact.title}, slide ${index + 1} of ${count}`}>
			<Theme theme={neutralTheme} mode="dark">
				<div
					ref={root}
					data-slot="present-mode"
					className={`flex h-dvh w-full items-center justify-center overflow-hidden bg-body ${controls.shown ? "" : "cursor-none"}`}
					style={size}
					onPointerMove={controls.show}
					onClick={onClick}
				>
					<div className="relative h-[calc(var(--slide-height)*var(--scale))] w-[calc(var(--slide-width)*var(--scale))] shrink-0 overflow-hidden">
						<iframe
							srcDoc={page}
							sandbox=""
							referrerPolicy="no-referrer"
							tabIndex={-1}
							title={artifact.title}
							className="pointer-events-none absolute left-0 top-0 h-(--deck-height) w-(--slide-width) origin-top-left border-0 [transform:scale(var(--scale))_translateY(var(--shift))]"
						/>
					</div>
					<div
						className={`absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface p-1 shadow-lg transition-opacity duration-300 ${controls.shown ? "opacity-100" : "pointer-events-none opacity-0"}`}
						onClick={(event) => event.stopPropagation()}
					>
						<IconButton label="Previous slide" variant="ghost" icon={<Icon icon="chevronLeft" />} isDisabled={index === 0} onClick={() => go(index - 1)} />
						<span className="min-w-14 text-center" aria-live="polite">
							<Text type="supporting" hasTabularNumbers>
								{index + 1} / {count}
							</Text>
						</span>
						<IconButton label="Next slide" variant="ghost" icon={<Icon icon="chevronRight" />} isDisabled={index === count - 1} onClick={() => go(index + 1)} />
						<IconButton label="Leave present mode" tooltip="Leave (Esc)" variant="ghost" icon={<Icon icon="close" />} onClick={leave} />
					</div>
				</div>
			</Theme>
		</Dialog>
	);
}

function useViewport() {
	const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
	useEffect(() => {
		const onResize = () => setViewport({ width: innerWidth, height: innerHeight });
		addEventListener("resize", onResize);
		return () => removeEventListener("resize", onResize);
	}, []);
	return viewport;
}

/** The controls show while the pointer moves, then fade so the slide is all that shows. */
function useControls() {
	const [shown, setShown] = useState(true);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const show = useCallback(() => {
		setShown(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setShown(false), 2000);
	}, []);
	useEffect(() => {
		show();
		return () => clearTimeout(timer.current);
	}, [show]);
	return { shown, show };
}
