import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack } from "@astryxdesign/core/Layout";
import { Icon } from "@astryxdesign/core/Icon";
import { ShieldExclamationIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { useStore } from "../../lib/store";
import { toastError } from "../../lib/toast";
import { toolLabeler, toolName, type ToolPart } from "../tool-renderers";
import { formatToolInput, humanizeToolName, summarizeToolInput } from "./tool-state";

/**
 * A tool call waiting on `approval-requested`. With `alwaysAllow` (a connector's labeler in
 * tool-renderers.ts) it also offers "Always allow", which saves the rule and then approves,
 * only if the card still shows the same call.
 */
export default function ApprovalCard({ part, onApproval }: { part: Extract<ToolPart, { state: "approval-requested" }>; onApproval: (approvalId: string, approved: boolean) => void }) {
	const label = useStore(toolLabeler)(toolName(part));
	const approvalId = part.approval.id;
	const current = useRef(approvalId);
	current.current = approvalId;
	const [saving, setSaving] = useState(false);
	const input = (part as { input?: unknown }).input;
	const summary = summarizeToolInput(input);
	const details = formatToolInput(input);

	async function always() {
		if (saving || !label?.alwaysAllow) return;
		setSaving(true);
		try {
			await label.alwaysAllow();
		} catch {
			toastError("The rule could not be saved. Try again, or allow this call once.");
			return;
		} finally {
			setSaving(false);
		}
		if (current.current === approvalId) onApproval(approvalId, true);
	}

	return (
		<Banner
			status="warning"
			icon={<Icon icon={ShieldExclamationIcon} />}
			title={label?.question ?? `Allow the agent to ${humanizeToolName(toolName(part))}?`}
			description={
				<>
					{summary && <span className="block truncate" data-slot="confirmation-summary">{summary}</span>}
					{part.approval.requestReason || "Nothing runs until you approve."}
				</>
			}
			endContent={
				<HStack gap={2} wrap="wrap">
					<Button label="Deny" size="sm" isDisabled={saving} onClick={() => onApproval(approvalId, false)} />
					{label?.alwaysAllow && <Button label="Always allow" size="sm" isLoading={saving} onClick={() => void always()} />}
					<Button label={label?.alwaysAllow ? "Allow once" : "Approve"} size="sm" variant="primary" isDisabled={saving} onClick={() => onApproval(approvalId, true)} />
				</HStack>
			}
			collapsible={details ? { defaultIsOpen: false } : false}
			data-slot="approval"
		>
			{details ? <CodeBlock code={details} language="json" isWrapped maxHeight={256} width="100%" container="section" size="sm" /> : undefined}
		</Banner>
	);
}

/** A bar over several pending approvals in one message, to answer them all at once. */
export function ApprovalBatch({ count, disabled, onAnswer }: { count: number; disabled: boolean; onAnswer: (approved: boolean) => void }) {
	return (
		<Banner
			status="warning"
			icon={<Icon icon={ShieldExclamationIcon} />}
			title={`${count} changes are waiting for you.`}
			description="Check them below, or answer them all at once."
			collapsible={false}
			endContent={
				<HStack gap={2}>
					<Button label="Deny all" size="sm" isDisabled={disabled} onClick={() => onAnswer(false)} />
					<Button label={`Approve all ${count}`} size="sm" variant="primary" isDisabled={disabled} onClick={() => onAnswer(true)} />
				</HStack>
			}
		/>
	);
}
