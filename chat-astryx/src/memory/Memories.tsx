import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Text } from "@astryxdesign/core/Text";
import { LightBulbIcon, PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { when } from "../lib/dates";
import { forgetMemory, KIND_LABELS, type Memory } from "../lib/memory";
import { toastError } from "../lib/toast";
import EditMemoryDialog from "./EditMemoryDialog";
import ThreadLink, { useThreadTitle } from "./ThreadLink";

type Props = { memories: Memory[]; onChanged: () => Promise<void>; onOpenThread: (id: string) => void };

/** What Ponder remembers, each with where it came from, and Edit and Forget. */
export default function Memories({ memories, onChanged, onOpenThread }: Props) {
	const [editing, setEditing] = useState<Memory | null>(null);
	const [forgetting, setForgetting] = useState<Memory | null>(null);
	const [busy, setBusy] = useState(false);

	async function forget() {
		if (!forgetting) return;
		setBusy(true);
		try {
			await forgetMemory(forgetting.id);
			setForgetting(null);
			await onChanged();
		} catch (error) {
			toastError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	if (!memories.length)
		return (
			<EmptyState
				icon={<Icon icon={LightBulbIcon} size="lg" color="secondary" />}
				title="Nothing remembered yet"
				description={'Tell Ponder about your work or how you like answers, or say "remember that…", and it will.'}
			/>
		);

	return (
		<>
			<Card padding={0} width="100%">
				<List hasDividers>
					{memories.map((memory) => (
						<MemoryRow key={memory.id} memory={memory} onEdit={setEditing} onForget={setForgetting} onOpenThread={onOpenThread} />
					))}
				</List>
			</Card>
			<EditMemoryDialog memory={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
			<AlertDialog
				isOpen={Boolean(forgetting)}
				onOpenChange={(isOpen) => !isOpen && !busy && setForgetting(null)}
				title="Forget this?"
				description={forgetting ? `Ponder will stop using "${forgetting.text}" in new chats. You can undo this under Decisions.` : ""}
				actionLabel="Forget"
				isActionLoading={busy}
				onAction={forget}
			/>
		</>
	);
}

function MemoryRow({ memory, onEdit, onForget, onOpenThread }: { memory: Memory; onEdit: (memory: Memory) => void; onForget: (memory: Memory) => void; onOpenThread: (id: string) => void }) {
	const source = useThreadTitle(memory.sourceThread);
	return (
		<ListItem
			align="start"
			label={<Text type="body">{memory.text}</Text>}
			description={
				<span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 pt-1">
					<span className="mr-1">
						<Badge label={KIND_LABELS[memory.kind]} />
					</span>
					{source && memory.sourceThread && (
						<>
							<ThreadLink id={memory.sourceThread} onOpen={onOpenThread}>
								From “{source}”
							</ThreadLink>
							<span aria-hidden="true">·</span>
						</>
					)}
					<span>{when(memory.updatedAt)}</span>
				</span>
			}
			endContent={
				<MoreMenu
					label={`Actions for ${memory.text}`}
					alignment="end"
					items={[
						{ label: "Edit", icon: <Icon icon={PencilIcon} />, onClick: () => onEdit(memory) },
						{ label: "Forget", icon: <Icon icon={TrashIcon} />, variant: "destructive" as const, onClick: () => onForget(memory) },
					]}
				/>
			}
		/>
	);
}
