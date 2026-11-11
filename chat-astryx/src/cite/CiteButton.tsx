import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ChatBubbleBottomCenterTextIcon } from "@heroicons/react/24/outline";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { PendingCite } from "./selection";

/** The floating Cite button under text selected in a reply (selection.ts). */
export default function CiteButton({ pending, onCite }: { pending: PendingCite; onCite: () => void }) {
	// The place follows the selection, so it is set as variables the classes read.
	const place = { "--cite-x": `${pending.x}px`, "--cite-y": `${pending.y}px` } as CSSProperties;
	return createPortal(
		<div data-cite-button className="fixed top-(--cite-y) left-(--cite-x) z-50 rounded-md bg-popover" style={place} onPointerDown={(event) => event.preventDefault()}>
			<Button
				label={pending.tooLong ? "Shorten selection" : "Cite"}
				tooltip={pending.tooLong ? "The selection is too long to quote" : "Quote the selection in your message"}
				variant="secondary"
				size="sm"
				elevation="med"
				icon={<Icon icon={ChatBubbleBottomCenterTextIcon} />}
				isDisabled={pending.tooLong}
				onClick={onCite}
			/>
		</div>,
		document.body,
	);
}
