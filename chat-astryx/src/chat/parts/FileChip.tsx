import { Icon } from "@astryxdesign/core/Icon";
import { Token } from "@astryxdesign/core/Token";
import { DocumentIcon } from "@heroicons/react/24/outline";
import { canView, viewFile } from "../../side-panel/panel";

/**
 * A file as a chip: an attachment on a message, or a file that Python made. A click opens
 * the side panel for a file it can show (a PDF, a CSV), and downloads any other file.
 */
export default function FileChip({ name, url, mediaType, size }: { name: string; url?: string; mediaType: string; size?: number }) {
	function open(event?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
		if (!url) return;
		// Cmd-, Ctrl- or Shift-click still opens the file in a new tab.
		if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) return void window.open(url, "_blank", "noopener");
		if (canView(mediaType, name)) return viewFile({ name, url, mediaType });
		const link = Object.assign(document.createElement("a"), { href: url, download: name });
		link.click();
	}
	return (
		<Token
			label={name}
			icon={<Icon icon={DocumentIcon} />}
			endContent={size !== undefined ? <span className="text-secondary">{fileSize(size)}</span> : undefined}
			onClick={url ? (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => open(event) : undefined}
			description={url && canView(mediaType, name) ? "Opens in the side panel" : url ? "Downloads the file" : undefined}
		/>
	);
}

function fileSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
