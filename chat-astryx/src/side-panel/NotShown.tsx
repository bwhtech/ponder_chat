import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { saveFile } from "./header";

/** A file the panel could not draw, with a way to download it. */
export default function NotShown({ title, url, name }: { title: string; url: string; name: string }) {
	return (
		<div className="flex justify-center px-6 pt-[20vh]">
			<EmptyState
				title={title}
				actions={<Button label="Download it" icon={<Icon icon={ArrowDownTrayIcon} />} onClick={() => saveFile({ url, name })} />}
			/>
		</div>
	);
}
