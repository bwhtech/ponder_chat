import { Icon } from "@astryxdesign/core/Icon";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { DocumentIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo } from "react";
import { fileSize } from "./files";

/** The files attached to the message being written: images as small previews, other files as chips. */
export default function Attachments({ files, onRemove }: { files: File[]; onRemove: (file: File) => void }) {
	// A preview link per image, let go when the image leaves (removed, or sent).
	const previews = useMemo(() => new Map(files.filter((file) => file.type.startsWith("image/")).map((file) => [file, URL.createObjectURL(file)])), [files]);
	useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);

	return files.map((file) => {
		const key = `${file.name}:${file.size}:${file.lastModified}`;
		const preview = previews.get(file);
		if (preview) return <Thumbnail key={key} src={preview} alt={file.name} label={file.name} onRemove={() => onRemove(file)} />;
		return (
			<Token
				key={key}
				data-slot="attachment"
				label={file.name}
				icon={<Icon icon={DocumentIcon} />}
				endContent={<span className="text-secondary">{fileSize(file.size)}</span>}
				onRemove={() => onRemove(file)}
			/>
		);
	});
}
