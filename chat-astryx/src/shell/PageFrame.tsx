import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, LayoutHeader, StackItem } from "@astryxdesign/core/Layout";
import { MobileNavToggle } from "@astryxdesign/core/MobileNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import { MoonIcon, PaintBrushIcon, PencilSquareIcon, SunIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { useStore } from "../lib/store";
import { themeMode } from "../lib/theme";
import { openSettings } from "../settings/state";

type PageFrameProps = {
	title: string;
	/** The open chat is still loading: the title is a placeholder. */
	isLoading: boolean;
	onNewChat: () => void;
	children: ReactNode;
};

/**
 * The page in the shell's content area: a pinned header over the open chat or Memory. On
 * phones the header carries the menu button (AppShell's own top bar is off), so the chat gets
 * one bar, not two. The title is in the body face, on one line; a long one shows in full in a
 * tooltip. The theme's display face stays for the landing's greeting.
 */
export default function PageFrame({ title, isLoading, onNewChat, children }: PageFrameProps) {
	return (
		<Layout
			height="fill"
			header={
				<LayoutHeader hasDivider label="Chat" padding={2}>
					<HStack gap={2} vAlign="center">
						<MobileNavToggle label="Open chats" />
						<StackItem size="fill">
							{isLoading ? (
								<Skeleton width={192} height={18} />
							) : (
								<Heading level={3} accessibilityLevel={1} weight="semibold" maxLines={1} className="font-sans">
									{title}
								</Heading>
							)}
						</StackItem>
						<HeaderActions onNewChat={onNewChat} />
					</HStack>
				</LayoutHeader>
			}
			content={
				<LayoutContent padding={0} isScrollable={false}>
					<div className="flex h-full min-h-0 flex-col">{children}</div>
				</LayoutContent>
			}
		/>
	);
}

/** Light or dark and the theme (wider screens; phones have them in the account menu), and a new chat. */
function HeaderActions({ onNewChat }: { onNewChat: () => void }) {
	const mode = useStore(themeMode);
	const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	return (
		<HStack gap={1} vAlign="center">
			<IconButton
				className="max-md:hidden"
				label={dark ? "Light mode" : "Dark mode"}
				tooltip={dark ? "Light mode" : "Dark mode"}
				variant="ghost"
				icon={<Icon icon={dark ? SunIcon : MoonIcon} />}
				onClick={() => themeMode.set(dark ? "light" : "dark")}
			/>
			<IconButton className="max-md:hidden" label="Theme" tooltip="Theme" variant="ghost" icon={<Icon icon={PaintBrushIcon} />} onClick={() => openSettings("appearance")} />
			<IconButton label="New chat" tooltip="New chat" variant="ghost" icon={<Icon icon={PencilSquareIcon} />} onClick={onNewChat} />
		</HStack>
	);
}
