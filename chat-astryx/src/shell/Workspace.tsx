import { AppShell } from "@astryxdesign/core/AppShell";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import {
	ArrowRightStartOnRectangleIcon,
	ComputerDesktopIcon,
	Cog6ToothIcon,
	LightBulbIcon,
	MoonIcon,
	PaintBrushIcon,
	PencilSquareIcon,
	PuzzlePieceIcon,
	SparklesIcon,
	ShieldCheckIcon,
	SunIcon,
} from "@heroicons/react/24/outline";
import { useLayoutEffect, type ReactNode } from "react";
import { displayName, me, refreshCredits, signOut } from "../lib/account";
import { useStore } from "../lib/store";
import { themeMode, type ThemeMode } from "../lib/theme";
import { current, loading, messages, open, refresh, revision, running, start, threads } from "../lib/threads";
import { showChat, showMemory, view } from "../lib/view";
import ChatView from "../chat/ChatView";
import ThreadSkeleton from "../chat/ThreadSkeleton";
import CreditMeter from "./CreditMeter";
import MemoryPage from "../memory/MemoryPage";
import { closePanel } from "../side-panel/panel";
import SidePanel from "../side-panel/SidePanel";
import { useSignInReturn } from "../connectors/use-sign-in-return";
import SettingsDialog from "../settings/SettingsDialog";
import { openSettings } from "../settings/state";
import ThreadList from "./ThreadList";

/**
 * The signed-in shell: chats in a side nav (a drawer on phones, which AppShell makes from
 * the same nav) and the open chat, or the Memory page. The account menu sits at the foot
 * of the nav, with Memory, Connectors, Settings, the theme and Sign out.
 */
export default function Workspace() {
	const person = useStore(me);
	const page = useStore(view);
	const id = useStore(current);
	const list = useStore(threads);
	const isLoading = useStore(loading);
	const shown = useStore(messages);
	const isRunning = useStore(running);
	const version = useStore(revision);
	const thread = list.find((each) => each.id === id);

	// The side panel shows a file or an artifact of the open chat, so it closes when the chat changes.
	// A layout effect runs before the new chat's effects, so an artifact it is writing can open again (ArtifactPart.tsx).
	useLayoutEffect(() => closePanel(), [id, page]);
	// Back from a connector's sign-in in this tab (a phone): opens Settings on that connector.
	useSignInReturn();

	function pick(threadId: string) {
		showChat();
		void open(threadId);
	}

	function newThread() {
		showChat();
		start();
	}

	const title = page === "memory" ? "Memory" : (thread?.title ?? "New chat");

	return (
		<AppShell
			contentPadding={0}
			mobileNav={{ breakpoint: "md" }}
			sideNav={
				<SideNav
					header={
						<SideNavHeading
							heading="Ponder"
							subheading={displayName(person)}
							icon={<NavIcon icon={<Icon icon={SparklesIcon} size="sm" />} />}
						/>
					}
					topContent={
						<div className="flex flex-col gap-2 pb-1">
							<div className="px-2">
								<Button label="New chat" icon={<Icon icon={PencilSquareIcon} />} variant="primary" width="100%" onClick={newThread} />
							</div>
							<SideNavSection title="Places" isHeaderHidden>
										<SideNavItem label="Memory" icon={LightBulbIcon} isSelected={page === "memory"} onClick={(event) => (event.preventDefault(), showMemory())} />
										<SideNavItem label="Connectors" icon={PuzzlePieceIcon} onClick={(event) => (event.preventDefault(), openSettings("connectors"))} />
							</SideNavSection>
						</div>
					}
					footer={
						<div className="flex flex-col gap-1 pb-2">
							{person && <CreditMeter credits={person.credits} />}
							<AccountMenu />
						</div>
					}
				>
					<ThreadList highlight={page === "chat"} onSelect={pick} />
				</SideNav>
			}
		>
			<div className="flex h-full min-h-0">
				<div className="flex min-w-0 flex-1 flex-col" data-slot="chat-column">
					<Toolbar
						label="Chat"
						size="lg"
						dividers={["bottom"]}
						startContent={
							isLoading && !thread && page === "chat" ? (
								<Skeleton width={192} height={18} />
							) : (
								<Heading level={1} className="block max-w-[calc(100vw-7rem)] truncate !text-lg md:max-w-[min(40rem,calc(100vw-30rem))]">
									{title}
								</Heading>
							)
						}
						endContent={<HeaderActions onNewChat={newThread} />}
					/>
					{page === "memory" ? (
						<MemoryPage onOpenThread={pick} />
					) : isLoading ? (
						<ThreadSkeleton />
					) : id ? (
						<ChatView key={`${id}:${version}`} threadId={id} initialMessages={shown} running={isRunning} onSaved={onSaved} onRefused={() => void refreshCredits()} />
					) : null}
				</div>
				<SidePanel />
			</div>
			<SettingsDialog />
		</AppShell>
	);
}

/** Quick actions at the right of the header: light or dark, the theme, and a new chat. */
function HeaderActions({ onNewChat }: { onNewChat: () => void }) {
	const mode = useStore(themeMode);
	const dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	return (
		<div className="flex items-center gap-1">
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
		</div>
	);
}

/** A reply finished: its place in the list and the credits left may have changed. */
function onSaved() {
	void refresh();
	void refreshCredits();
}

const THEMES: { mode: ThemeMode; label: string; icon: typeof SunIcon }[] = [
	{ mode: "light", label: "Light", icon: SunIcon },
	{ mode: "dark", label: "Dark", icon: MoonIcon },
	{ mode: "system", label: "System", icon: ComputerDesktopIcon },
];

/** Memory, Admin (for admins), Connectors, Appearance, Settings, light or dark, and Sign out. */
function AccountMenu() {
	const person = useStore(me);
	const mode = useStore(themeMode);
	const name = displayName(person);
	const item = (label: string, icon: typeof SunIcon, onClick: () => void, extra: ReactNode = undefined) => ({
		label,
		icon: <Icon icon={icon} />,
		onClick,
		endContent: extra,
	});
	return (
		<div className="px-2">
			<DropdownMenu
				placement="above"
				menuWidth={240}
				hasChevron={false}
				button={{ label: name, variant: "ghost", width: "100%", icon: <Avatar name={name} size="sm" /> }}
				items={[
					item("Memory", LightBulbIcon, showMemory),
					...(person?.user.role === "admin" ? [item("Admin", ShieldCheckIcon, () => location.assign("/admin"))] : []),
					item("Connectors", PuzzlePieceIcon, () => openSettings("connectors")),
					item("Appearance", PaintBrushIcon, () => openSettings("appearance")),
					item("Settings", Cog6ToothIcon, () => openSettings("account")),
					{ type: "divider" as const },
					...THEMES.map((theme) => ({
						label: `${theme.label} mode`,
						icon: <Icon icon={theme.icon} />,
						onClick: () => themeMode.set(theme.mode),
						endContent: mode === theme.mode ? <Icon icon="check" size="sm" color="secondary" /> : undefined,
					})),
					{ type: "divider" as const },
					item("Sign out", ArrowRightStartOnRectangleIcon, () => void signOut()),
				]}
			/>
		</div>
	);
}
