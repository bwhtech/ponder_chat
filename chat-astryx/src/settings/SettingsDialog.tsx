import { Dialog } from "@astryxdesign/core/Dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, StackItem } from "@astryxdesign/core/Layout";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading } from "@astryxdesign/core/Text";
import { PaintBrushIcon, PuzzlePieceIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useEffect, useId } from "react";
import AddConnector from "../connectors/AddConnector";
import { connectors, connectorsError, loadConnectors, needsAttention } from "../connectors/api";
import ConnectorPage from "../connectors/ConnectorPage";
import ConnectorsPanel from "../connectors/ConnectorsPanel";
import RemoveConnectorDialog from "../connectors/RemoveConnectorDialog";
import { registerToolLabels } from "../connectors/tool-labels";
import { useStore } from "../lib/store";
import AccountPanel from "./AccountPanel";
import AppearancePanel from "./AppearancePanel";
import { closeSettings, openSettings, settings, toggleSettings, type SettingsPlace, type SettingsTab } from "./state";

/**
 * Settings, with Account, Appearance and Connectors: a side nav and the open panel, after Astryx's
 * settings-dialog template. Cmd+Shift+, (Ctrl+Shift+,) opens it too. On a phone it fills
 * the screen, with the sections as tabs at the top.
 */
const TABS: { tab: SettingsTab; label: string; icon: typeof UserCircleIcon }[] = [
	{ tab: "account", label: "Account", icon: UserCircleIcon },
	{ tab: "appearance", label: "Appearance", icon: PaintBrushIcon },
	{ tab: "connectors", label: "Connectors", icon: PuzzlePieceIcon },
];

export default function SettingsDialog() {
	const place = useStore(settings);
	const list = useStore(connectors);
	const attention = needsAttention(list);
	const narrow = useMediaQuery("(max-width: 639px)");
	const titleId = useId();
	const panelId = useId();
	const open = Boolean(place);

	// The chat shows connector tools by their connector's name, and asks before they run.
	useEffect(() => {
		void loadConnectors().catch(() => undefined);
		return registerToolLabels();
	}, []);

	// The list loads again when Settings opens, so a sign-in that ended elsewhere shows. When it
	// fails, Connectors shows why, with Try again (connectorsError in connectors/api.ts).
	useEffect(() => {
		if (open) void loadConnectors().catch(() => undefined);
	}, [open]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.code !== "Comma" || !event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			toggleSettings();
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, []);

	const tab = place?.tab ?? "account";
	const dot = attention ? <StatusDot variant="warning" label={`${attention} need attention`} /> : null;
	const pick = (next: SettingsTab) => openSettings(next);
	const close = <IconButton label="Close settings" variant="ghost" size="sm" icon={<Icon icon="close" size="sm" />} onClick={closeSettings} />;

	return (
		<>
			<Dialog
				isOpen={open}
				onOpenChange={(isOpen) => !isOpen && closeSettings()}
				variant={narrow ? "fullscreen" : "standard"}
				width={960}
				maxHeight="min(640px, calc(100dvh - 4rem))"
				padding={0}
				aria-labelledby={titleId}
			>
				{place &&
					(narrow ? (
						<div className="flex h-full flex-col">
							<HStack gap={2} vAlign="center" padding={3}>
								<StackItem size="fill">
									<Heading level={4} id={titleId}>
										Settings
									</Heading>
								</StackItem>
								{close}
							</HStack>
							<TabList value={tab} onChange={(next) => pick(next as SettingsTab)} size="sm" role="tablist" aria-label="Settings sections" hasDivider>
								{TABS.map((each) => (
									<Tab
										key={each.tab}
										value={each.tab}
										label={each.label}
										panelId={panelId}
										icon={<Icon icon={each.icon} size="sm" />}
										endContent={each.tab === "connectors" ? dot : undefined}
									/>
								))}
							</TabList>
							<div id={panelId} role="tabpanel" aria-label={TABS.find((each) => each.tab === tab)?.label} className="@container min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
								<Panel place={place} />
							</div>
						</div>
					) : (
						<div className="h-[min(640px,calc(100dvh-4rem))]">
							<Layout
								start={
									<SideNav
										aria-label="Settings sections"
										header={
											<div className="flex min-h-8 items-center px-2">
												<Heading level={4} id={titleId}>
													Settings
												</Heading>
											</div>
										}
									>
										<SideNavSection title="Settings" isHeaderHidden>
											{TABS.map((each) => (
												<SideNavItem
													key={each.tab}
													label={each.label}
													icon={<Icon icon={each.icon} size="sm" color="primary" />}
													isSelected={each.tab === tab}
													endContent={each.tab === "connectors" ? dot : undefined}
													onClick={() => pick(each.tab)}
												/>
											))}
										</SideNavSection>
									</SideNav>
								}
								content={
									<LayoutContent isScrollable padding={6}>
										{/* Close, pinned to the corner while the panel scrolls under it. */}
										<div className="sticky top-0 z-10 flex h-0 justify-end">
											<div className="flex rounded-md bg-surface">{close}</div>
										</div>
										<div className="@container pr-10">
											<Panel place={place} />
										</div>
									</LayoutContent>
								}
							/>
						</div>
					))}
			</Dialog>
			<RemoveConnectorDialog />
		</>
	);
}

/** The open tab's panel. On Connectors: the list, a connector's page, or Add connector. */
function Panel({ place }: { place: SettingsPlace }) {
	const list = useStore(connectors);
	const error = useStore(connectorsError);
	if (place.tab === "account") return <AccountPanel />;
	if (place.tab === "appearance") return <AppearancePanel />;
	if (place.adding) return <AddConnector />;
	const connector = list?.find((each) => each.id === place.connector);
	return connector && !error ? <ConnectorPage key={connector.id} connector={connector} /> : <ConnectorsPanel />;
}
