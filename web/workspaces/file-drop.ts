import { computed, ref } from "vue";

/**
 * Files dropped on an element, while `enabled`. `active` while files are dragged over it,
 * for the drop state. dragenter and dragleave fire for each child, so a count tells when
 * the files left the element.
 */
export function useFileDrop(enabled: () => boolean, onFiles: (files: File[]) => void) {
	const depth = ref(0);
	const active = computed(() => enabled() && depth.value > 0);

	const hasFiles = (event: DragEvent) => enabled() && Boolean(event.dataTransfer?.types.includes("Files"));

	const listeners = {
		dragenter(event: DragEvent) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth.value++;
		},
		dragover(event: DragEvent) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.dataTransfer!.dropEffect = "copy";
		},
		dragleave(event: DragEvent) {
			if (hasFiles(event)) depth.value = Math.max(0, depth.value - 1);
		},
		drop(event: DragEvent) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth.value = 0;
			onFiles(Array.from(event.dataTransfer?.files ?? []));
		},
	};
	return { active, listeners };
}
