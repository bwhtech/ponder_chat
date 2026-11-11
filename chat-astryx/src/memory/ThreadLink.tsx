import { Link } from "@astryxdesign/core/Link";
import type { MouseEvent, ReactNode } from "react";
import { useStore } from "../lib/store";
import { threads } from "../lib/threads";

/** The chat a memory or decision came from, by its title. Nothing when that chat is gone. */
export function useThreadTitle(id: string | null) {
	const list = useStore(threads);
	return id ? (list.find((thread) => thread.id === id)?.title ?? null) : null;
}

/** Opens the chat here; a click with a modifier key opens it in a new tab. */
export default function ThreadLink({ id, onOpen, children }: { id: string; onOpen: (id: string) => void; children: ReactNode }) {
	function click(event: MouseEvent) {
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		onOpen(id);
	}
	return (
		<Link href={`/?t=${encodeURIComponent(id)}`} color="secondary" size="sm" maxLines={1} onClick={click}>
			{children}
		</Link>
	);
}
