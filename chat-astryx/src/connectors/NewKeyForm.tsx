import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useRef, useState, type FormEvent } from "react";
import { toast, toastError } from "../lib/toast";
import { changeConnector, type Connector, type Header } from "./api";
import HeadersInput from "./HeadersInput";

/**
 * A new API key, in place on the connector's page (Settings is a dialog already). The
 * server checks the key before it is saved. Each form is a new session, so a save from
 * an earlier one does not close this one.
 */
export default function NewKeyForm({ connector: c, onDone }: { connector: Connector; onDone: () => void }) {
	const [rows, setRows] = useState<Header[]>(() => (c.headerNames.length ? c.headerNames : ["Authorization"]).map((name) => ({ name, value: "" })));
	const [saving, setSaving] = useState(false);
	const live = useRef(true);

	async function save(event: FormEvent) {
		event.preventDefault();
		if (!rows.every((row) => row.value.trim()) || saving) return;
		setSaving(true);
		try {
			await changeConnector(c.id, { headers: rows });
			// The key was saved either way, so the toast shows; only its own form closes.
			toast(`Saved. ${c.name} accepted the key.`);
			if (live.current) onDone();
		} catch (error) {
			toastError(error instanceof Error ? error.message : "The key was not saved.");
		} finally {
			if (live.current) setSaving(false);
		}
	}

	function cancel() {
		live.current = false;
		onDone();
	}

	return (
		<Card variant="muted" width="100%">
			<form className="flex flex-col gap-4" onSubmit={save}>
				<div className="flex flex-col gap-0.5">
					<Heading level={3}>New API key for {c.name}</Heading>
					<Text type="supporting" color="secondary">
						Ponder checks the key with {c.name} before it saves it, encrypted.
					</Text>
				</div>
				<HeadersInput rows={rows} onChange={setRows} namesFixed />
				<div className="flex justify-end gap-2">
					<Button label="Cancel" variant="secondary" onClick={cancel} />
					<Button type="submit" label="Save" variant="primary" isLoading={saving} isDisabled={!rows.every((row) => row.value.trim())} />
				</div>
			</form>
		</Card>
	);
}
