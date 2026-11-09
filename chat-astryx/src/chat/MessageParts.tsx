import { Button } from "@astryxdesign/core/Button";
import { ChatMessageBubble, ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Token } from "@astryxdesign/core/Token";
import type { UIMessage } from "ai";
import { Fragment, type ReactNode } from "react";
import { useStore } from "../lib/store";
import { humanize, toolLabeler, toolName, toolRenderers, type ToolPart } from "./tool-renderers";

/**
 * Every part of one UIMessage, in order. Text is Markdown; a run of reasoning and tool
 * parts without a renderer of their own folds into one ChatToolCalls row; a tool with a
 * renderer (tool-renderers.ts) draws itself; files show as images or chips.
 */
type Part = UIMessage["parts"][number];
type FilePart = Extract<Part, { type: "file" }>;

export type MessagePartsProps = {
	message: UIMessage;
	streaming: boolean;
	/** The person answered a tool that waited for approval. */
	onApproval?: (approvalId: string, approved: boolean) => void;
};

type Group = { kind: "steps"; parts: Part[] } | { kind: "tool"; part: ToolPart } | { kind: "text"; part: Extract<Part, { type: "text" }> } | { kind: "files"; parts: FilePart[] };

export default function MessageParts({ message, streaming, onApproval }: MessagePartsProps) {
	const renderers = useStore(toolRenderers);
	const groups = groupParts(message.parts, renderers);
	const lastText = message.parts.map((part) => part.type).lastIndexOf("text");
	return (
		<>
			{groups.map((group, index) => {
				const key = groupKey(group, index);
				if (group.kind === "text") {
					if (!group.part.text.trim()) return null;
					if (message.role === "user") return <ChatMessageBubble key={key}>{group.part.text}</ChatMessageBubble>;
					return (
						<ChatMessageBubble key={key} variant="ghost" width="100%">
							<Markdown density="compact" isStreaming={streaming && message.parts.indexOf(group.part) === lastText} autolink="gfm" contentWidth="100%">
								{group.part.text}
							</Markdown>
						</ChatMessageBubble>
					);
				}
				if (group.kind === "files") return <Files key={key} parts={group.parts} />;
				if (group.kind === "tool") {
					const name = toolName(group.part);
					const Renderer = renderers[name]!.component;
					return (
						<ChatMessageBubble key={key} variant="ghost" width="100%">
							<Renderer part={group.part} name={name} message={message} streaming={streaming} />
						</ChatMessageBubble>
					);
				}
				return <Steps key={key} parts={group.parts} streaming={streaming} onApproval={onApproval} />;
			})}
		</>
	);
}

function groupParts(parts: Part[], renderers: Record<string, { foldable?: boolean }>): Group[] {
	const groups: Group[] = [];
	for (const part of parts) {
		const last = groups[groups.length - 1];
		if (isTool(part) && renderers[toolName(part)] && !renderers[toolName(part)]!.foldable) groups.push({ kind: "tool", part });
		else if (isStep(part) && last?.kind === "steps") last.parts.push(part);
		else if (isStep(part)) groups.push({ kind: "steps", parts: [part] });
		else if (part.type === "file" && last?.kind === "files") last.parts.push(part);
		else if (part.type === "file") groups.push({ kind: "files", parts: [part] });
		else if (part.type === "text") groups.push({ kind: "text", part });
	}
	return groups;
}

/** Keys from part identity: a tool part is its call id; other parts are their place in the list, which only grows. */
function groupKey(group: Group, index: number) {
	if (group.kind === "tool") return `tool:${group.part.toolCallId}`;
	if (group.kind === "steps") {
		const first = group.parts[0];
		return `steps:${first && isTool(first) ? first.toolCallId : index}`;
	}
	return `${group.kind}:${index}`;
}

export function isTool(part: Part): part is ToolPart {
	return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function isStep(part: Part) {
	return part.type === "reasoning" || isTool(part);
}

/** Reasoning and tool calls as one folded row. A call waiting for approval keeps the row open. */
function Steps({ parts, streaming, onApproval }: { parts: Part[]; streaming: boolean; onApproval?: MessagePartsProps["onApproval"] }) {
	const labeler = useStore(toolLabeler);
	const renderers = useStore(toolRenderers);
	const calls: ChatToolCallItem[] = parts.map((part, index) => {
		if (part.type === "reasoning") {
			const thinking = streaming && part.state === "streaming";
			return {
				key: `reasoning:${index}`,
				name: thinking ? "Thinking" : "Thought",
				status: thinking ? "running" : "complete",
				resultDetail: part.text.trim() ? (
					<Markdown density="compact" contentWidth="100%">
						{part.text}
					</Markdown>
				) : undefined,
			};
		}
		const tool = part as ToolPart;
		const name = toolName(tool);
		const Renderer = renderers[name]?.component;
		return {
			key: `tool:${tool.toolCallId}`,
			name: labeler(name)?.title ?? humanize(name),
			target: target(tool),
			status: callStatus(tool),
			errorMessage: tool.state === "output-error" ? tool.errorText : undefined,
			resultDetail: Renderer ? <Renderer part={tool} name={name} message={{ id: "", role: "assistant", parts }} streaming={streaming} /> : <ToolDetail part={tool} />,
		};
	});
	const waiting = parts.filter((part): part is ToolPart => isTool(part) && part.state === "approval-requested");
	return (
		<ChatMessageBubble variant="ghost" width="100%">
			<ChatToolCalls calls={calls} defaultIsExpanded={waiting.length > 0} />
			{waiting.map((part) => (
				<Fragment key={part.toolCallId}>{onApproval && <ApprovalRow part={part} onApproval={onApproval} />}</Fragment>
			))}
		</ChatMessageBubble>
	);
}

function callStatus(part: ToolPart): ChatToolCallItem["status"] {
	switch (part.state) {
		case "output-available":
			return "complete";
		case "output-error":
		case "output-denied":
			return "error";
		case "approval-requested":
			return "pending";
		default:
			return "running";
	}
}

/** What a call acts on, in a word or two: a query, a URL, a file name. */
function target(part: ToolPart): string | undefined {
	const input = (part as { input?: unknown }).input;
	if (!input || typeof input !== "object") return undefined;
	for (const key of ["query", "url", "title", "name", "path", "id"]) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === "string" && value) return value.length > 80 ? `${value.slice(0, 80)}…` : value;
	}
	return undefined;
}

/** A call's input and output as JSON, for tools without a renderer of their own. */
function ToolDetail({ part }: { part: ToolPart }) {
	const input = (part as { input?: unknown }).input;
	const output = part.state === "output-available" ? part.output : undefined;
	const blocks: ReactNode[] = [];
	if (input !== undefined) blocks.push(<CodeBlock key="input" title="Input" language="json" code={pretty(input)} />);
	if (output !== undefined) blocks.push(<CodeBlock key="output" title="Output" language="json" code={pretty(output)} />);
	return blocks.length ? <div className="flex flex-col gap-2">{blocks}</div> : null;
}

function pretty(value: unknown) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

/** A connector tool on "Ask first" waits for the person. Placeholder until the approval card is ported. */
function ApprovalRow({ part, onApproval }: { part: ToolPart; onApproval: NonNullable<MessagePartsProps["onApproval"]> }) {
	const approval = (part as { approval?: { id: string } }).approval;
	if (!approval) return null;
	return (
		<div className="mt-2 flex gap-2" data-slot="approval">
			<Button label="Allow" variant="primary" size="sm" onClick={() => onApproval(approval.id, true)} />
			<Button label="Deny" variant="secondary" size="sm" onClick={() => onApproval(approval.id, false)} />
		</div>
	);
}

/** Attached files: images as pictures, other files as chips. */
function Files({ parts }: { parts: FilePart[] }) {
	return (
		<div className="flex flex-wrap justify-end gap-2" data-slot="message-files">
			{parts.map((part, index) =>
				part.mediaType.startsWith("image/") && part.url ? (
					<a key={index} href={part.url} target="_blank" rel="noreferrer">
						<img src={part.url} alt={part.filename ?? "Image"} className="max-h-48 max-w-60 rounded-lg border border-border object-cover" />
					</a>
				) : (
					<Token key={index} label={part.filename ?? "File"} />
				),
			)}
		</div>
	);
}
