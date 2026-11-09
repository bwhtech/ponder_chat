import { AppShell } from "@astryxdesign/core/AppShell";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { SideNav, SideNavHeading } from "@astryxdesign/core/SideNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Heading } from "@astryxdesign/core/Text";
import {
	ArrowRightStartOnRectangleIcon,
	ComputerDesktopIcon,
	Cog6ToothIcon,
	LightBulbIcon,
	MoonIcon,
	PencilSquareIcon,
	PuzzlePieceIcon,
	ShieldCheckIcon,
	SunIcon,
} from "@heroicons/react/24/outline";
import { useEffect, type ReactNode } from "react";
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
	useEffect(() => closePanel(), [id, page]);

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
			variant="section"
			contentPadding={0}
			mobileNav={{ breakpoint: "md" }}
			sideNav={
				<SideNav
					header={<SideNavHeading heading="Ponder Chat" subheading={displayName(person)} icon={<img src="/logo.png" alt="" className="size-6" />} />}
					topContent={
						<div className="px-2 pb-2">
							<Button label="New chat" icon={<Icon icon={PencilSquareIcon} />} variant="secondary" width="100%" onClick={newThread} />
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
					<header data-slot="chat-header" className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-4">
						{isLoading && !thread && page === "chat" ? (
							<div className="min-w-0 flex-1">
								<Skeleton width={192} height={16} />
							</div>
						) : (
							<Heading level={1} className="min-w-0 flex-1 truncate !text-base">
								{title}
							</Heading>
						)}
					</header>
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

/** Memory, Admin (for admins), Connectors, Settings, Theme and Sign out. */
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
				button={{ label: name, variant: "ghost", width: "100%", icon: <Avatar name={name} size="xsm" /> }}
				items={[
					item("Memory", LightBulbIcon, showMemory),
					...(person?.user.role === "admin" ? [item("Admin", ShieldCheckIcon, () => location.assign("/admin"))] : []),
					item("Connectors", PuzzlePieceIcon, () => openSettings("connectors")),
					item("Settings", Cog6ToothIcon, () => openSettings("account")),
					{ type: "divider" as const },
					...THEMES.map((theme) => ({
						label: `${theme.label} theme`,
						icon: <Icon icon={theme.icon} />,
						onClick: () => themeMode.set(theme.mode),
						endContent: mode === theme.mode ? <span className="text-secondary">✓</span> : undefined,
					})),
					{ type: "divider" as const },
					item("Sign out", ArrowRightStartOnRectangleIcon, () => void signOut()),
				]}
			/>
		</div>
	);
}
