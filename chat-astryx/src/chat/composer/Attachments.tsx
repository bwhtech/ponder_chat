import { Icon } from "@astryxdesign/core/Icon";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { DocumentIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { fileSize } from "../../lib/numbers";

/** The files attached to the message being written: images as small previews, other files as chips. */
export default function Attachments({ files, onRemove }: { files: File[]; onRemove: (file: File) => void }) {
	return files.map((file) => {
		const key = `${file.name}:${file.size}:${file.lastModified}`;
		if (file.type.startsWith("image/")) return <ImagePreview key={key} file={file} onRemove={() => onRemove(file)} />;
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

/** An image's preview. Its link is made and let go in one effect, so StrictMode's replay makes a new one. */
function ImagePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		const link = URL.createObjectURL(file);
		setUrl(link);
		return () => URL.revokeObjectURL(link);
	}, [file]);
	return <Thumbnail src={url} alt={file.name} label={file.name} onRemove={onRemove} />;
}
