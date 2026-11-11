import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useState, type KeyboardEvent } from "react";
import { CITATION_MAX_COMMENT } from "./citations";

/**
 * The comment on a citation. Enter saves, Cmd/Ctrl+Enter saves and sends the message,
 * Shift+Enter starts a new line, Escape cancels. Adapted from T3 Code.
 */
export type CommentEditorProps = {
	comment?: string;
	onDraft: (comment: string) => void;
	onSave: (comment: string) => void;
	onSend: (comment: string) => void;
	onCancel: () => void;
};

export default function CommentEditor({ comment, onDraft, onSave, onSend, onCancel }: CommentEditorProps) {
	const [draft, setDraft] = useState(comment ?? "");
	const tooLong = draft.length > CITATION_MAX_COMMENT;

	function onKeyDown(event: KeyboardEvent) {
		event.stopPropagation();
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
			return;
		}
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		if (tooLong) return;
		if (event.metaKey || event.ctrlKey) onSend(draft);
		else onSave(draft);
	}

	return (
		<VStack gap={2} className="w-80 max-w-[calc(100vw-2rem)]" data-slot="cite-comment-editor" onKeyDown={onKeyDown}>
			<TextArea
				label="Comment on the quoted text"
				isLabelHidden
				placeholder="Add an optional comment…"
				rows={2}
				hasAutoFocus
				value={draft}
				onChange={(value) => {
					setDraft(value);
					onDraft(value);
				}}
				status={tooLong ? { type: "error", message: `Comments can have up to ${CITATION_MAX_COMMENT.toLocaleString()} characters.` } : undefined}
			/>
			<HStack gap={2} hAlign="end">
				<Button label="Cancel" variant="secondary" size="sm" onClick={onCancel} />
				<Button label="Save" variant="primary" size="sm" isDisabled={tooLong} onClick={() => onSave(draft)} />
			</HStack>
		</VStack>
	);
}
