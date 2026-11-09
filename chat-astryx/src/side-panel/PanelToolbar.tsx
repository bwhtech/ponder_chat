import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { ArrowDownTrayIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { slideCount } from "../artifacts/slides";
import { saveFile, type PanelHeader } from "./header";
import { closePanel, type PanelItem } from "./panel";

/**
 * The panel's header: what it shows, and Present, Copy, Download, Open in a new tab and Close.
 * Beside the chat it is a toolbar; where the panel covers the page it is the dialog's header,
 * whose title takes the focus when it opens.
 */
type Props = {
	item: PanelItem;
	header: PanelHeader;
	narrow: boolean;
	pageView: "preview" | "code";
	onPageView: (view: "preview" | "code") => void;
	onPresent: () => void;
};

export default function PanelToolbar({ narrow, header, ...actions }: Props) {
	if (narrow)
		return (
			<DialogHeader
				title={header.title}
				subtitle={header.meta || undefined}
				startContent={<Icon icon={header.look.icon} color={header.look.color} size="sm" />}
				endContent={<Actions header={header} {...actions} />}
				onOpenChange={(open) => !open && closePanel()}
			/>
		);
	return (
		<Toolbar
			label={`${header.title} actions`}
			dividers={["bottom"]}
			startContent={
				<div className="flex min-w-0 items-center gap-2">
					<Icon icon={header.look.icon} color={header.look.color} size="sm" />
					<Text type="label" weight="semibold" maxLines={1}>
						{header.title}
					</Text>
					{header.meta && (
						<span className="shrink-0 whitespace-nowrap">
							<Text type="supporting">{header.meta}</Text>
						</span>
					)}
				</div>
			}
			endContent={
				<>
					<Actions header={header} {...actions} />
					<IconButton label="Close" tooltip="Close (Esc)" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={closePanel} />
				</>
			}
		/>
	);
}

function Actions({ item, header, pageView, onPageView, onPresent }: Omit<Props, "narrow">) {
	const artifact = item.type === "artifact" ? item.artifact : null;
	const file = item.type === "file" ? item.file : null;
	const canPresent = artifact?.kind === "slides" && !artifact.writing && slideCount(artifact.content) > 0;
	return (
		<>
			{artifact?.kind === "html" && !artifact.writing && (
				<SegmentedControl label="Show" size="sm" value={pageView} onChange={(value) => onPageView(value as "preview" | "code")}>
					<SegmentedControlItem value="preview" label="Preview" />
					<SegmentedControlItem value="code" label="Code" />
				</SegmentedControl>
			)}
			{canPresent && <Button label="Present" variant="ghost" size="sm" icon={<Icon icon={PlayIcon} />} onClick={onPresent} />}
			{artifact && <CopyContent text={artifact.content} label={header.copyLabel} disabled={artifact.writing} />}
			{header.download && (
				<IconButton
					label="Download"
					tooltip="Download"
					variant="ghost"
					size="sm"
					icon={<Icon icon={ArrowDownTrayIcon} />}
					onClick={() => saveFile(header.download!())}
				/>
			)}
			{file && (
				<IconButton
					label="Open in a new tab"
					tooltip="Open in a new tab"
					variant="ghost"
					size="sm"
					icon={<Icon icon="externalLink" />}
					href={file.url}
					target="_blank"
					rel="noreferrer noopener"
				/>
			)}
		</>
	);
}

/** Copies the artifact's Markdown or HTML, and says so for a moment. */
function CopyContent({ text, label, disabled }: { text: string; label: string; disabled: boolean }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<IconButton
			label={label}
			tooltip={copied ? "Copied" : label}
			variant="ghost"
			size="sm"
			isDisabled={disabled}
			icon={<Icon icon={copied ? "check" : "copy"} />}
			onClick={() =>
				void navigator.clipboard.writeText(text).then(
					() => setCopied(true),
					() => undefined,
				)
			}
		/>
	);
}
