import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ChatBubbleLeftRightIcon, ExclamationCircleIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../lib/store";
import { excerptPieces, useThreadSearch } from "../lib/thread-search";
import { current, listLoaded, prefetch, remove, rename, threads, type ThreadSummary } from "../lib/threads";
import { toastError } from "../lib/toast";
import { threadActions } from "./thread-actions";

/**
 * The person's threads, grouped by when they were last active, with a search box above.
 * Each row has rename, delete, and the actions other modules add (thread-actions.ts). While
 * the box has text, the list shows the chats that match, each with an excerpt.
 */
export default function ThreadList({ highlight, onSelect }: { highlight: boolean; onSelect: (id: string) => void }) {
	const list = useStore(threads);
	const loaded = useStore(listLoaded);
	const open = useStore(current);
	const [query, setQuery] = useState("");
	const searching = Boolean(query.trim());
	const search = useThreadSearch(query);
	const [renaming, setRenaming] = useState<ThreadSummary | null>(null);
	const [deleting, setDeleting] = useState<ThreadSummary | null>(null);

	// The open chat stays in view: on load, and when it is opened from elsewhere (a link, a search hit).
	useEffect(() => {
		requestAnimationFrame(() => document.querySelector('[data-thread-row][data-open="true"]')?.scrollIntoView({ block: "nearest" }));
	}, [open, loaded]);

	const groups = useMemo(() => groupByDay(list), [list]);

	return (
		<>
			<div className="px-2 pb-2">
				<TextInput
					type="search"
					label="Search chats"
					isLabelHidden
					placeholder="Search chats"
					startIcon={MagnifyingGlassIcon}
					value={query}
					onChange={setQuery}
					onKeyDown={(event) => event.key === "Escape" && setQuery("")}
					size="sm"
					width="100%"
				/>
			</div>

			{searching ? (
				<SideNavSection title="Results" isHeaderHidden>
					<div aria-busy={search.searching} data-slot="thread-search-results">
						{search.searching && !search.hits.length ? (
							<VStack gap={3} className="px-3 py-2" aria-label="Searching chats">
								{[144, 176, 112].map((width, index) => (
									<VStack key={width} gap={1}>
										<Skeleton width={width} height={14} index={index} />
										<Skeleton height={10} index={index} />
									</VStack>
								))}
							</VStack>
						) : null}
						<div className={search.searching ? "opacity-50" : undefined}>
							{search.hits.map((hit) => (
								<Item
									key={hit.id}
									data-thread-row
									data-open={highlight && hit.id === open}
									density="compact"
									className="rounded-md px-1.5"
									label={hit.title}
									description={
										hit.excerpt &&
										excerptPieces(hit.excerpt).map((piece, index) =>
											piece.match ? (
												<mark key={index} className="bg-transparent font-semibold text-primary">
													{piece.text}
												</mark>
											) : (
												<span key={index}>{piece.text}</span>
											),
										)
									}
									descriptionLines={2}
									isSelected={highlight && hit.id === open}
									onClick={() => onSelect(hit.id)}
									onPointerEnter={() => prefetch(hit.id)}
								/>
							))}
						</div>
						{search.failed ? (
							<EmptyState isCompact icon={<Icon icon={ExclamationCircleIcon} size="lg" color="secondary" />} title="Search did not work" description="Check your connection, then try again." />
						) : !search.searching && !search.hits.length ? (
							<EmptyState isCompact icon={<Icon icon={MagnifyingGlassIcon} size="lg" color="secondary" />} title="No chats match" description="Try other words, or fewer of them." />
						) : null}
					</div>
				</SideNavSection>
			) : !loaded ? (
				<VStack gap={2} className="px-3 py-2" aria-busy="true" aria-label="Loading threads">
					{[160, 128, 176, 112, 144].map((width, index) => (
						<Skeleton key={width} width={width} height={14} index={index} />
					))}
				</VStack>
			) : !list.length ? (
				<EmptyState isCompact icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" color="secondary" />} title="No chats yet" description="Your chats show up here once you start one." />
			) : (
				groups.map((group) => (
					<SideNavSection key={group.label} title={group.label}>
						{group.threads.map((thread) => (
							<ThreadRow
								key={thread.id}
								thread={thread}
								isOpen={highlight && thread.id === open}
								onSelect={() => onSelect(thread.id)}
								onRename={() => setRenaming(thread)}
								onDelete={() => setDeleting(thread)}
							/>
						))}
					</SideNavSection>
				))
			)}

			<RenameDialog thread={renaming} onClose={() => setRenaming(null)} />
			<AlertDialog
				isOpen={Boolean(deleting)}
				onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
				title="Delete this thread?"
				description={deleting ? `"${deleting.title}" and its messages will be deleted.` : ""}
				actionLabel="Delete"
				onAction={async () => {
					const thread = deleting;
					setDeleting(null);
					if (thread) await remove(thread.id).catch((error: Error) => toastError(error.message));
				}}
			/>
		</>
	);
}

type ThreadRowProps = { thread: ThreadSummary; isOpen: boolean; onSelect: () => void; onRename: () => void; onDelete: () => void };

/**
 * One chat in the list. With a mouse, its actions menu shows on hover, on focus, and on the
 * open chat, as in Astryx's shell-side-nav template, so the title gets the row's width; on
 * touch screens it always shows.
 */
function ThreadRow({ thread, isOpen, onSelect, onRename, onDelete }: ThreadRowProps) {
	const canHover = useMediaQuery("(hover: hover) and (pointer: fine)");
	const [isHovered, setIsHovered] = useState(false);
	const [isFocused, setIsFocused] = useState(false);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const showActions = !canHover || isHovered || isFocused || isMenuOpen || isOpen;
	return (
		<div
			data-thread-row
			data-open={isOpen}
			className="scroll-my-10"
			onPointerEnter={() => (setIsHovered(true), prefetch(thread.id))}
			onPointerLeave={() => setIsHovered(false)}
			onFocus={() => (setIsFocused(true), prefetch(thread.id))}
			onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setIsFocused(false)}
			onTouchStart={() => prefetch(thread.id)}
		>
			<SideNavItem
				label={thread.title}
				size="sm"
				isSelected={isOpen}
				onClick={(event) => {
					event.preventDefault();
					onSelect();
				}}
				actions={
					showActions && (
						<MoreMenu
							size="sm"
							label={`Actions for ${thread.title}`}
							alignment="end"
							onOpenChange={setIsMenuOpen}
							items={[
								{ label: "Rename", onClick: onRename },
								...threadActions.get().map((action) => ({ label: action.label, onClick: () => action.run(thread) })),
								{ label: "Delete", variant: "destructive" as const, onClick: onDelete },
							]}
						/>
					)
				}
			/>
		</div>
	);
}

function RenameDialog({ thread, onClose }: { thread: ThreadSummary | null; onClose: () => void }) {
	const [title, setTitle] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => setTitle(thread?.title ?? ""), [thread]);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!thread || !title.trim()) return;
		setSaving(true);
		try {
			await rename(thread.id, title.trim());
			onClose();
		} catch (error) {
			toastError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog isOpen={Boolean(thread)} onOpenChange={(isOpen) => !isOpen && onClose()} purpose="form" width={420}>
			<form onSubmit={save}>
				<DialogHeader title="Rename thread" onOpenChange={(isOpen) => !isOpen && onClose()} />
				<VStack gap={4} className="p-4">
					<TextInput label="Name" value={title} onChange={setTitle} hasAutoFocus isRequired width="100%" />
					<HStack gap={2} hAlign="end">
						<Button label="Cancel" variant="secondary" onClick={onClose} />
						<Button type="submit" label="Rename" variant="primary" isLoading={saving} isDisabled={!title.trim()} />
					</HStack>
				</VStack>
			</form>
		</Dialog>
	);
}

/** Today, Yesterday, Previous 7 days, Older: by when each thread was last active. */
function groupByDay(list: ThreadSummary[]) {
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	const day = 24 * 60 * 60 * 1000;
	const buckets: [string, (time: number) => boolean][] = [
		["Today", (time) => time >= startOfToday],
		["Yesterday", (time) => time >= startOfToday - day],
		["Previous 7 days", (time) => time >= startOfToday - 7 * day],
		["Older", () => true],
	];
	const grouped = buckets.map(([label]) => ({ label, threads: [] as ThreadSummary[] }));
	for (const thread of list) {
		const time = new Date(thread.updatedAt).getTime();
		grouped[buckets.findIndex(([, matches]) => matches(time))].threads.push(thread);
	}
	return grouped.filter((group) => group.threads.length);
}
