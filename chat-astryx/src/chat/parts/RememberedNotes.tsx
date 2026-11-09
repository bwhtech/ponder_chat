import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { BookmarkIcon } from "@heroicons/react/24/outline";
import { canUndo, type MemorySave } from "../../lib/memory";
import { MEMORY_LABELS, type Remembered } from "../../lib/remembered-notes";
import { toastError } from "../../lib/toast";
import { showMemory } from "../../lib/view";

/**
 * What a reply added to memory, under the reply: one line per change, which opens Memory,
 * and Undo for the save. Saves that arrived after the chat opened fade in.
 */
export default function RememberedNotes({ notes, fresh, onUndo }: { notes: Remembered[]; fresh: Set<number>; onUndo: (save: MemorySave) => Promise<void> }) {
	return (
		<>
			{notes.map(({ save, operations }) => (
				<div
					key={save.id}
					data-slot="memory-saved"
					className={`flex flex-wrap items-center gap-x-2 ${fresh.has(save.id) ? "transition-opacity duration-300 ease-out starting:opacity-0 motion-reduce:transition-none" : ""}`}
				>
					<div className="flex min-w-0 flex-col">
						{operations.map((op) => (
							<Link
								key={op.memoryId + op.op}
								href="?view=memory"
								color="secondary"
								tooltip="Open Memory"
								data-slot="memory-note"
								onClick={(event) => {
									event.preventDefault();
									showMemory();
								}}
							>
								<span className={`flex items-start gap-2 ${save.undoneAt ? "line-through" : ""}`}>
									<Icon icon={BookmarkIcon} size="sm" className="mt-0.5 shrink-0" />
									<Text type="supporting" color="inherit">
										<Text type="supporting" color="primary">
											{MEMORY_LABELS[op.op]}:
										</Text>{" "}
										{op.op === "forget" ? op.note : op.text}
									</Text>
								</span>
							</Link>
						))}
					</div>
					{canUndo(save) ? (
						<Button label="Undo" variant="ghost" size="sm" data-slot="memory-undo" clickAction={() => onUndo(save).catch((error: Error) => toastError(error.message))} />
					) : save.undoneAt ? (
						<Text type="supporting" color="disabled">
							Undone
						</Text>
					) : null}
				</div>
			))}
		</>
	);
}
