import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useEffect, useState, type FormEvent } from "react";
import { updateMemory, type Memory } from "../lib/memory";
import { toastError } from "../lib/toast";

/** Edit memory: the text Ponder remembers, changed by hand. */
export default function EditMemoryDialog({ memory, onClose, onSaved }: { memory: Memory | null; onClose: () => void; onSaved: () => Promise<void> }) {
	const [text, setText] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => setText(memory?.text ?? ""), [memory]);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!memory || !text.trim()) return;
		setSaving(true);
		try {
			await updateMemory(memory.id, text.trim());
			onClose();
			await onSaved();
		} catch (error) {
			toastError((error as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const close = (isOpen: boolean) => !isOpen && onClose();
	return (
		<Dialog isOpen={Boolean(memory)} onOpenChange={close} purpose="form" width={480}>
			<form onSubmit={save}>
				<DialogHeader title="Edit memory" onOpenChange={close} />
				<VStack gap={4} className="p-4">
					<TextArea label="What Ponder remembers" value={text} onChange={setText} rows={4} isRequired hasAutoFocus width="100%" />
					<HStack gap={2} hAlign="end">
						<Button label="Cancel" variant="secondary" onClick={onClose} />
						<Button type="submit" label="Save" variant="primary" isLoading={saving} isDisabled={!text.trim()} />
					</HStack>
				</VStack>
			</form>
		</Dialog>
	);
}
