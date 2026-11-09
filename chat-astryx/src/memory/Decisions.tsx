import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { ExclamationCircleIcon, LightBulbIcon, ListBulletIcon, MinusCircleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { when } from "../lib/dates";
import { canUndo, undoSave, type MemorySave } from "../lib/memory";
import ThreadLink, { useThreadTitle } from "./ThreadLink";

type Props = { saves: MemorySave[]; onChanged: () => Promise<void>; onOpenThread: (id: string) => void };

const OP_LABELS = { add: "Remembered", update: "Updated", forget: "Forgot" } as const;

const applied = (save: MemorySave) => save.operations.filter((op) => op.status === "applied");

/** Ponder's latest decisions about what to remember, each with what it changed, and Undo. */
export default function Decisions({ saves, onChanged, onOpenThread }: Props) {
	/** The decisions being undone now: each shows its own spinner. */
	const [undoing, setUndoing] = useState<Set<number>>(new Set());
	const [undoError, setUndoError] = useState("");

	async function undo(save: MemorySave) {
		setUndoing((ids) => new Set(ids).add(save.id));
		setUndoError("");
		try {
			await undoSave(save.id);
			await onChanged();
		} catch (error) {
			setUndoError((error as Error).message);
		} finally {
			setUndoing((ids) => {
				const next = new Set(ids);
				next.delete(save.id);
				return next;
			});
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<Text type="supporting" color="secondary">
				After every reply, Ponder decides whether the chat held anything worth remembering. Most of the time it doesn't. These are its latest decisions.
			</Text>
			{undoError && <Banner status="error" title={undoError} />}
			{saves.length ? (
				<Card padding={0} width="100%">
					<List hasDividers>
						{saves.map((save) => (
							<DecisionRow key={save.id} save={save} undoing={undoing.has(save.id)} onUndo={undo} onOpenThread={onOpenThread} />
						))}
					</List>
				</Card>
			) : (
				<EmptyState icon={<Icon icon={ListBulletIcon} size="lg" color="secondary" />} title="No decisions yet" />
			)}
		</div>
	);
}

function DecisionRow({ save, undoing, onUndo, onOpenThread }: { save: MemorySave; undoing: boolean; onUndo: (save: MemorySave) => void; onOpenThread: (id: string) => void }) {
	const thread = useThreadTitle(save.threadId);
	const changes = applied(save);
	const icon = !save.ok ? (
		<Icon icon={ExclamationCircleIcon} size="sm" color="error" />
	) : changes.length ? (
		<Icon icon={LightBulbIcon} size="sm" color="primary" />
	) : (
		<Icon icon={MinusCircleIcon} size="sm" color="disabled" />
	);

	return (
		<ListItem
			align="start"
			startContent={<span className="flex pt-0.5">{icon}</span>}
			label={
				<Text type="body" color={changes.length ? "primary" : "secondary"}>
					{save.summary}
				</Text>
			}
			description={
				<span className="flex flex-col gap-1 pt-1">
					{changes.length > 0 && (
						<ul className="flex flex-col gap-0.5">
							{changes.map((op) => (
								<li key={op.memoryId + op.op}>
									<Text type="supporting" color="secondary" hasStrikethrough={Boolean(save.undoneAt)}>
										<Text type="supporting" color="primary">
											{OP_LABELS[op.op]}:
										</Text>{" "}
										{op.op === "forget" ? op.note : op.text}
									</Text>
								</li>
							))}
						</ul>
					)}
					{save.error && <span className="text-error">{save.error}</span>}
					<span className="flex min-w-0 flex-wrap gap-x-1">
						{thread && save.threadId && (
							<>
								<ThreadLink id={save.threadId} onOpen={onOpenThread}>
									“{thread}”
								</ThreadLink>
								<span aria-hidden="true">·</span>
							</>
						)}
						<span>{when(save.createdAt)}</span>
						{save.model && (
							<>
								<span aria-hidden="true">·</span>
								<span>{save.model}</span>
							</>
						)}
					</span>
				</span>
			}
			endContent={
				save.undoneAt ? <Badge label="Undone" /> : canUndo(save) ? <Button label="Undo" variant="ghost" size="sm" isLoading={undoing} onClick={() => onUndo(save)} /> : undefined
			}
		/>
	);
}
