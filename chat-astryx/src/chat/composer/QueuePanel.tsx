import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowTurnUpRightIcon, Bars2Icon, PaperClipIcon, PencilIcon, QueueListIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState, type KeyboardEvent } from "react";
import type { QueuedRow } from "../../lib/message-queue";

/**
 * Messages the person wrote while the agent was still working, above the message field.
 * Each row can be dragged into a new order, edited in place, removed, or sent now with
 * Steer (the page stops the current reply first). The page owns the list and sends the
 * first item when the agent is free.
 */
export type QueuePanelProps = {
	items: QueuedRow[];
	/** The row being edited. The page holds it back from sending until the edit is saved or dropped. */
	editing: string | null;
	onEditingChange: (id: string | null) => void;
	onSteer: (id: string) => void;
	onRemove: (id: string) => void;
	onUpdate: (id: string, text: string) => void;
	onReorder: (ids: string[]) => void;
};

export default function QueuePanel(props: QueuePanelProps) {
	const { items, editing } = props;
	const [draft, setDraft] = useState("");
	const [dragged, setDragged] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	// The page sent or removed the row being edited: drop the edit, there is nothing left to save it to.
	const gone = editing !== null && !items.some((item) => item.id === editing);
	const { onEditingChange } = props;
	useEffect(() => {
		if (gone) onEditingChange(null);
	}, [gone, onEditingChange]);
	if (!items.length) return null;

	function edit(item: QueuedRow) {
		setDraft(item.text);
		props.onEditingChange(item.id);
	}

	function save() {
		if (editing && draft.trim()) props.onUpdate(editing, draft.trim());
		props.onEditingChange(null);
	}

	function onEditKeyDown(event: KeyboardEvent) {
		if (event.key === "Escape") props.onEditingChange(null);
		else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			save();
		}
	}

	function drop(target: string) {
		const from = dragged;
		setDragged(null);
		setOver(null);
		if (!from || from === target) return;
		const ids = items.map((item) => item.id).filter((id) => id !== from);
		const at = ids.indexOf(target);
		// Either row may have been sent while it was dragged.
		if (at === -1 || ids.length === items.length) return;
		ids.splice(at, 0, from);
		props.onReorder(ids);
	}

	return (
		<section data-slot="prompt-input-queue" aria-label="Queued messages" className="mx-3 rounded-t-lg border border-b-0 border-border bg-muted px-2 py-1">
			<Collapsible
				chevronPosition="end"
				trigger={
					<HStack gap={2} vAlign="center" className="w-full">
						<Icon icon={QueueListIcon} size="sm" color="secondary" />
						<Text color="secondary" className="flex-1">
							Queued
						</Text>
						<Text color="secondary" hasTabularNumbers>
							{items.length}
						</Text>
					</HStack>
				}
			>
				<ol className="pb-1">
					{items.map((item) => (
						<li
							key={item.id}
							data-slot="prompt-input-queue-item"
							className={`flex items-center gap-1.5 py-0.5 ${over === item.id && dragged !== item.id ? "border-t-2 border-border-emphasized" : ""}`}
							onDragOver={(event) => {
								event.preventDefault();
								setOver(item.id);
							}}
							onDragLeave={() => over === item.id && setOver(null)}
							onDrop={(event) => {
								event.preventDefault();
								drop(item.id);
							}}
						>
							<span
								draggable={items.length > 1}
								aria-hidden="true"
								className={`flex shrink-0 cursor-grab text-secondary ${items.length < 2 ? "invisible" : ""}`}
								onDragStart={() => setDragged(item.id)}
								onDragEnd={() => {
									setDragged(null);
									setOver(null);
								}}
							>
								<Icon icon={Bars2Icon} size="sm" color="inherit" />
							</span>
							{editing === item.id ? (
								<div className="min-w-0 flex-1">
									<TextInput label="Edit queued message" isLabelHidden size="sm" hasAutoFocus value={draft} onChange={setDraft} onKeyDown={onEditKeyDown} onBlur={save} />
								</div>
							) : (
								<span className="flex min-w-0 flex-1 items-center gap-1" title={item.text}>
									<Text maxLines={1} hasTruncateTooltip={false} className="min-w-0">
										{item.text}
									</Text>
									{item.files > 0 && (
										<span className="inline-flex shrink-0 items-center gap-0.5 text-secondary">
											<Icon icon={PaperClipIcon} size="xsm" color="inherit" />
											<Text type="supporting">{item.files}</Text>
										</span>
									)}
								</span>
							)}
							<IconButton label="Edit" tooltip="Edit" variant="ghost" size="sm" icon={<Icon icon={PencilIcon} />} onClick={() => edit(item)} />
							<Button label="Steer" tooltip="Stop the current reply and send this now" variant="ghost" size="sm" icon={<Icon icon={ArrowTurnUpRightIcon} />} onClick={() => props.onSteer(item.id)} />
							<IconButton label="Remove" tooltip="Remove" variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} />} onClick={() => props.onRemove(item.id)} />
						</li>
					))}
				</ol>
			</Collapsible>
		</section>
	);
}
