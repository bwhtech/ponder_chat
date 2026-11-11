import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { useEffect, useState } from "react";

/** Copies a reply's text, and says so for a moment. */
export default function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<IconButton
			label={copied ? "Copied" : "Copy"}
			tooltip={copied ? "Copied" : "Copy"}
			variant="ghost"
			size="sm"
			icon={<Icon icon={copied ? "checkDouble" : "copy"} />}
			onClick={() => {
				void navigator.clipboard.writeText(value).then(() => setCopied(true));
			}}
		/>
	);
}
