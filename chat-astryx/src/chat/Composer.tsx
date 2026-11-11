import { Banner } from "@astryxdesign/core/Banner";
import { ChatComposer, ChatComposerDrawer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { PaperClipIcon } from "@heroicons/react/24/outline";
import { useRef, type KeyboardEvent } from "react";
import { ComposerCitationChip } from "../cite/CitationChip";
import CiteButton from "../cite/CiteButton";
import SkillChip from "../skills/SkillChip";
import Attachments from "./composer/Attachments";
import CreditNotice from "./composer/CreditNotice";
import QueuePanel from "./composer/QueuePanel";
import SendButton from "./composer/SendButton";
import Suggestions from "./composer/Suggestions";
import type { ComposerState } from "./composer/useComposer";
import { useFileDrop } from "./composer/useFileDrop";
import ModelPicker from "./ModelPicker";

/**
 * The message field and what sits around it: the out-of-credits notice, the queue, the
 * attached files, chosen skills and quotes, the model, Send, Queue and Stop. The state and
 * the send pipeline live in useComposer (composer/useComposer.ts).
 */
export type ComposerProps = {
	composer: ComposerState;
	onStop: () => void;
	model: string;
	onModelChange: (id: string) => void;
	status?: { type: "error" | "warning"; message?: string };
	/** A new chat: suggestions show under the field. */
	isEmpty: boolean;
	outOfCredits: boolean;
};

export default function Composer({ composer, onStop, model, onModelChange, status, isEmpty, outOfCredits }: ComposerProps) {
	const { skills, cites, queue, files } = composer;
	const fileInput = useRef<HTMLInputElement>(null);
	const drop = useFileDrop(composer.attach, composer.disabled);
	const hasChips = files.length > 0 || skills.chosen.length > 0 || cites.chips.length > 0;

	function onKeyDown(event: KeyboardEvent<HTMLElement>) {
		skills.onKeyDown(event);
		// Enter with no text still sends what the chips hold; the field sends only text.
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composer.input.trim() && composer.canSubmit) {
			event.preventDefault();
			void composer.send("");
		}
	}

	return (
		<VStack gap={2} className="mx-auto w-full max-w-[760px]">
			<CreditNotice />
			{composer.uploadError && <Banner status="error" title={composer.uploadError} description="Attach the files again to send them." />}
			<div {...drop.handlers} data-dragging={drop.dragging || undefined} className="rounded-xl [&_:has(>[data-slot=composer-footer-actions])]:min-w-0 data-dragging:outline-2 data-dragging:outline-offset-2 data-dragging:outline-accent data-dragging:outline-dashed">
				<QueuePanel
					items={queue.items}
					editing={queue.editing}
					onEditingChange={queue.setEditing}
					onSteer={(id) => void queue.steer(id)}
					onRemove={queue.remove}
					onUpdate={queue.update}
					onReorder={queue.reorder}
				/>
				<ChatComposer
					value={composer.input}
					onChange={composer.setInput}
					onSubmit={() => void composer.send()}
					onStop={onStop}
					isStopShown={composer.busy}
					isDisabled={composer.disabled}
					status={status}
					drawer={
						hasChips && (
							<ChatComposerDrawer label="Attachments">
								<HStack gap={1.5} wrap="wrap" vAlign="center" data-slot="prompt-input-chips">
									<Attachments files={files} onRemove={composer.removeFile} />
									{skills.chosen.map((name) => (
										<SkillChip key={name} name={name} onRemove={() => skills.remove(name)} />
									))}
									{cites.chips.map((citation, index) => (
										<ComposerCitationChip
											key={`${citation.messageId}:${citation.start}:${citation.end}`}
											citation={citation}
											editing={cites.editing === index}
											onReveal={() => cites.reveal(citation)}
											onEdit={() => cites.edit(index)}
											onRemove={() => cites.remove(index)}
											onSave={(comment) => cites.save(index, comment)}
											onSend={(comment) => composer.saveAndSend(index, comment)}
											onCancel={() => cites.cancel(index)}
										/>
									))}
								</HStack>
							</ChatComposerDrawer>
						)
					}
					input={
						<ChatComposerInput
							handleRef={composer.field}
							value={composer.input}
							onChange={composer.setInput}
							onSubmit={(text) => void composer.send(text)}
							placeholder={skills.placeholder}
							label="Message"
							triggers={skills.triggers}
							onFiles={composer.attach}
							onKeyDown={onKeyDown}
							hasHistory={false}
							pasteAsToken={false}
							maxRows={10}
						/>
					}
					footerActions={
						<HStack gap={1} vAlign="center" className="min-w-0" data-slot="composer-footer-actions">
							<IconButton label="Attach files" tooltip="Attach files" variant="ghost" size="sm" icon={<Icon icon={PaperClipIcon} />} isDisabled={composer.disabled} onClick={() => fileInput.current?.click()} />
							<ModelPicker value={model} onChange={onModelChange} />
							{composer.uploading && <Text type="supporting">Uploading…</Text>}
						</HStack>
					}
					sendButton={<SendButton busy={composer.busy} canSubmit={composer.canSubmit} onSubmit={() => void composer.send()} onStop={onStop} />}
				/>
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					accept={composer.accept}
					onChange={(event) => {
						composer.attach(Array.from(event.target.files ?? []));
						event.target.value = "";
					}}
				/>
			</div>
			{isEmpty && !outOfCredits && <Suggestions onSelect={(text) => void composer.send(text)} />}
			{cites.pending && <CiteButton pending={cites.pending} onCite={cites.cite} />}
		</VStack>
	);
}
