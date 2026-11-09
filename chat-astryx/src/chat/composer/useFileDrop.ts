import { useEffect, useRef, useState, type DragEvent } from "react";

/**
 * Files dropped anywhere on the message box are attached. Only a drag that carries files
 * lights the box up; dragging selected text does not. Enter and leave pair up as the
 * pointer crosses children, so a depth count reaches 0 only when the drag leaves the box
 * (or Esc ends it). A drop anywhere also resets it.
 */
export function useFileDrop(attach: (files: File[]) => void, disabled: boolean) {
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);

	useEffect(() => {
		const end = () => {
			depth.current = 0;
			setDragging(false);
		};
		addEventListener("drop", end);
		addEventListener("dragend", end);
		return () => {
			removeEventListener("drop", end);
			removeEventListener("dragend", end);
		};
	}, []);

	const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

	return {
		dragging,
		handlers: {
			onDragEnter(event: DragEvent) {
				if (!hasFiles(event)) return;
				depth.current++;
				setDragging(!disabled);
			},
			onDragOver(event: DragEvent) {
				if (hasFiles(event)) event.preventDefault();
			},
			onDragLeave(event: DragEvent) {
				if (!hasFiles(event)) return;
				depth.current = Math.max(0, depth.current - 1);
				if (depth.current === 0) setDragging(false);
			},
			onDrop(event: DragEvent) {
				depth.current = 0;
				setDragging(false);
				// The field takes a drop on itself (onFiles); this is the rest of the box.
				if (event.defaultPrevented || !hasFiles(event)) return;
				event.preventDefault();
				attach(Array.from(event.dataTransfer.files));
			},
		},
	};
}
