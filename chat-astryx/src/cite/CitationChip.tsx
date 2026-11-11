import { Blockquote } from "@astryxdesign/core/Blockquote";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { Popover } from "@astryxdesign/core/Popover";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { ArrowUpRightIcon, ChatBubbleBottomCenterTextIcon, PencilIcon } from "@heroicons/react/24/outline";
import { useRef, useState, type RefObject } from "react";
import { CITATION_MAX_COMMENT, citationLabel, type Citation } from "./citations";
import CommentEditor from "./CommentEditor";

const quoteIcon = <Icon icon={ChatBubbleBottomCenterTextIcon} size="sm" />;

/**
 * A quote from an earlier reply in the message box. Its label scrolls to the quote, the
 * pencil opens the comment editor, and the cross takes it out.
 */
export type ComposerCitationChipProps = {
	citation: Citation;
	editing: boolean;
	onReveal: () => void;
	onEdit: () => void;
	onRemove: () => void;
	onSave: (comment: string) => void;
	onSend: (comment: string) => void;
	onCancel: () => void;
};

export function ComposerCitationChip(props: ComposerCitationChipProps) {
	const { citation, editing } = props;
	const label = citationLabel(citation);
	const chip = useRef<HTMLSpanElement>(null);
	// What the editor holds. A click outside saves it only when it changed, like T3 Code;
	// otherwise the click away counts as Cancel.
	const draft = useRef<string | null>(null);

	function onOpenChange(open: boolean) {
		if (open || !editing) return;
		// Too long to save: the editor stays open and says so.
		if (draft.current !== null && draft.current.length > CITATION_MAX_COMMENT) return;
		const changed = draft.current !== null && draft.current.trim() !== (citation.comment ?? "").trim();
		if (changed) props.onSave(draft.current!);
		else props.onCancel();
		draft.current = null;
	}

	function finish(done: () => void) {
		draft.current = null;
		done();
	}

	return (
		<>
			<Token
				ref={chip}
				data-slot="citation-chip"
				label={label}
				color="blue"
				size="sm"
				icon={quoteIcon}
				description="Show the quoted text"
				onClick={props.onReveal}
				onRemove={props.onRemove}
				endContent={
					<IconButton
						label={citation.comment ? "Edit the comment" : "Add a comment"}
						variant="ghost"
						size="sm"
						icon={<Icon icon={PencilIcon} size="xsm" />}
						onClick={props.onEdit}
					/>
				}
			/>
			<Popover anchorRef={chip as RefObject<HTMLElement>} isOpen={editing} onOpenChange={onOpenChange} placement="above" label="Comment on the quote" padding={2} content={
				editing && (
					<CommentEditor
						comment={citation.comment}
						onDraft={(value) => (draft.current = value)}
						onSave={(comment) => finish(() => props.onSave(comment))}
						onSend={(comment) => finish(() => props.onSend(comment))}
						onCancel={() => finish(props.onCancel)}
					/>
				)
			} />
		</>
	);
}

/** A quote on a sent message: a click opens a card with the quote, the comment, and Go to source. */
export function SentCitationChip({ citation, onReveal }: { citation: Citation; onReveal: () => void }) {
	const [open, setOpen] = useState(false);
	const label = citationLabel(citation);
	return (
		<Popover
			isOpen={open}
			onOpenChange={setOpen}
			placement="above"
			alignment="end"
			label="Quoted reply text"
			content={
				<VStack gap={3} hAlign="start" className="w-96 max-w-[calc(100vw-2rem)]" data-slot="citation-card">
					<VStack gap={3} className="max-h-64 self-stretch overflow-y-auto break-words whitespace-pre-wrap">
						<Blockquote>{citation.text}</Blockquote>
						{citation.comment && <Text>{citation.comment}</Text>}
					</VStack>
					<Button
						label="Go to source"
						variant="secondary"
						size="sm"
						icon={<Icon icon={ArrowUpRightIcon} />}
						onClick={() => {
							setOpen(false);
							// Closing hands focus back to the chip; the jump to the quote waits a frame for it.
							requestAnimationFrame(onReveal);
						}}
					/>
				</VStack>
			}
		>
			<Token data-slot="citation-chip" label={label} color="blue" size="sm" icon={quoteIcon} description={`Quoted reply text: ${label}`} />
		</Popover>
	);
}
