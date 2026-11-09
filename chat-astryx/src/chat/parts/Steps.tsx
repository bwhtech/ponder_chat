import { ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Markdown } from "@astryxdesign/core/Markdown";
import type { UIMessage } from "ai";
import { useStore } from "../../lib/store";
import { toolLabeler, toolName, toolRenderers, type ToolLabel, type ToolPart, type ToolRenderer } from "../tool-renderers";
import ApprovalCard from "./ApprovalCard";
import { foldSteps, isTool, needsAnswer, summarizeSteps } from "./steps";
import { callStatus, formatToolInput, formatToolOutput, humanizeToolName, phaseError, toolPhase, toolTitle } from "./tool-state";

type Part = UIMessage["parts"][number];

export type StepsProps = {
	parts: Part[];
	message: UIMessage;
	streaming: boolean;
	/** The person answered a tool that waited for approval. */
	onApproval: (approvalId: string, approved: boolean) => void;
};

/**
 * A run of reasoning and tool parts. Two or more plain steps in a row fold under one line
 * ("Looked up 4 things"); a tool the app draws itself, and a call waiting for approval,
 * stand on their own, so nothing to answer is ever hidden.
 */
export default function Steps({ parts, message, streaming, onApproval }: StepsProps) {
	const renderers = useStore(toolRenderers);
	const labeler = useStore(toolLabeler);
	const custom = new Set(Object.keys(renderers).filter((name) => !renderers[name]!.foldable));
	const toCall = (part: Part, index: number) => stepCall(part, index, { message, streaming, renderers, labeler });
	return (
		<div className="flex min-w-0 flex-col gap-1" data-slot="message-steps">
			{foldSteps(parts, custom).map((item, index) => {
				if (item.kind === "fold") {
					const { summary, failed } = summarizeSteps(item.parts, streaming);
					return <ChatToolCalls key={stepKey(item.parts[0]!, index)} calls={item.parts.map(toCall)} label={failed ? `${summary} · ${failed} failed` : summary} />;
				}
				const part = item.part;
				if (needsAnswer(part)) return <ApprovalCard key={stepKey(part, index)} part={part} onApproval={onApproval} />;
				const Renderer = isTool(part) && custom.has(toolName(part)) ? renderers[toolName(part)]!.component : undefined;
				if (Renderer && isTool(part)) return <Renderer key={stepKey(part, index)} part={part} name={toolName(part)} message={message} streaming={streaming} />;
				return <ChatToolCalls key={stepKey(part, index)} calls={[toCall(part, index)]} />;
			})}
		</div>
	);
}

/** Keys from part identity: answering an approval folds it into the steps before it, so rows shift. */
function stepKey(part: Part, index: number) {
	return isTool(part) ? `tool:${part.toolCallId}` : `${part.type}:${index}`;
}

type CallContext = { message: UIMessage; streaming: boolean; renderers: Record<string, ToolRenderer>; labeler: (name: string) => ToolLabel | undefined };

function stepCall(part: Part, index: number, { message, streaming, renderers, labeler }: CallContext): ChatToolCallItem {
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
	const phase = toolPhase(tool, { streaming });
	const base = { key: `tool:${tool.toolCallId}`, status: callStatus(phase), errorMessage: phaseError(tool, phase) };
	const renderer = renderers[name];
	if (renderer?.line) {
		const props = { part: tool, name, message, streaming };
		const Renderer = renderer.component;
		return { ...base, ...renderer.line(props), resultDetail: tool.state === "output-available" ? <Renderer {...props} /> : undefined };
	}
	// The app's own name for the tool, such as a connector's "Linear · Create issue".
	return { ...base, name: labeler(name)?.title ?? toolTitle(phase, humanizeToolName(name)), target: target(tool), resultDetail: <ToolDetail part={tool} /> };
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

/** A call's input and its result, or the error when it failed. MCP text content is unwrapped. */
function ToolDetail({ part }: { part: ToolPart }) {
	const input = formatToolInput((part as { input?: unknown }).input);
	const result =
		part.state === "output-error"
			? { code: part.errorText, language: "plaintext", isError: true }
			: part.state === "output-available"
				? formatToolOutput(part.output)
				: null;
	if (!input && !result) return null;
	return (
		<div className="flex flex-col gap-2">
			{input && <CodeBlock title="Input" language="json" code={input} size="sm" width="100%" maxHeight={256} isWrapped />}
			{result && <CodeBlock title={result.isError ? "Error" : "Result"} language={result.language} code={result.code} size="sm" width="100%" maxHeight={256} isWrapped />}
		</div>
	);
}
