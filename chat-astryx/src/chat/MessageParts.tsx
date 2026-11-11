import { ChatMessageBubble } from "@astryxdesign/core/Chat";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import type { UIMessage } from "ai";
import { Fragment, useMemo } from "react";
import SkillChip from "../skills/SkillChip";
import { chosenSkills } from "../skills/skills";
import { viewOrOpen } from "../side-panel/panel";
import { ApprovalBatch } from "./parts/ApprovalCard";
import FileChip from "./parts/FileChip";
import Reply from "./parts/Reply";
import SourceList from "./parts/SourceList";
import { collectSources, sourceUrls } from "./parts/sources";
import Steps from "./parts/Steps";
import { isStep, isTool, needsAnswer } from "./parts/steps";

/**
 * Every part of one UIMessage, in order. Runs of reasoning and tool parts sit together as
 * steps (parts/Steps.tsx); text is Markdown, with links to the pages the reply's tools
 * found as citation chips; files show as images or chips; sources collect at the end.
 */
type Part = UIMessage["parts"][number];
type FilePart = Extract<Part, { type: "file" }>;
type TextPart = Extract<Part, { type: "text" }>;
type Group = { kind: "steps"; parts: Part[] } | { kind: "text"; part: TextPart } | { kind: "files"; parts: FilePart[] };

export type MessagePartsProps = {
	message: UIMessage;
	streaming: boolean;
	/** The person answered a tool that waited for approval. */
	onApproval?: (approvalId: string, approved: boolean) => void;
};

export default function MessageParts({ message, streaming, onApproval = () => {} }: MessagePartsProps) {
	const groups = groupParts(message.parts);
	/** Pages the reply's tools returned; links to them show as citation chips. */
	const sources = useMemo(() => collectSources(message), [message]);
	const used = sourceUrls(message);
	const skills = chosenSkills(message);
	const lastText = message.parts.map((part) => part.type).lastIndexOf("text");
	/** Approval ids still waiting on the person; two or more get an "answer all" bar. */
	const pending = message.parts.filter(needsAnswer).map((part) => part.approval.id);
	const firstPending = groups.findIndex((group) => group.kind === "steps" && group.parts.some(needsAnswer));

	return (
		<>
			{skills.length > 0 && (
				<div className="flex max-w-full flex-wrap justify-end gap-1.5 self-end" data-slot="message-skills">
					{skills.map((name) => (
						<SkillChip key={name} name={name} />
					))}
				</div>
			)}
			{groups.map((group, index) => {
				const key = groupKey(group, message.parts);
				if (group.kind === "text") {
					if (!group.part.text.trim()) return null;
					// Keep the person's line breaks and indents; a long word or URL still wraps.
					if (message.role === "user")
						return (
							<ChatMessageBubble key={key}>
								<span className="whitespace-pre-wrap wrap-anywhere">{group.part.text}</span>
							</ChatMessageBubble>
						);
					return (
						<ChatMessageBubble key={key} variant="ghost" width="100%">
							<Reply text={group.part.text} streaming={streaming && message.parts.indexOf(group.part) === lastText} sources={sources} />
						</ChatMessageBubble>
					);
				}
				if (group.kind === "files") return <Files key={key} parts={group.parts} />;
				return (
					<Fragment key={key}>
						{index === firstPending && pending.length > 1 && (
							<ApprovalBatch count={pending.length} disabled={streaming} onAnswer={(approved) => pending.forEach((id) => onApproval(id, approved))} />
						)}
						<ChatMessageBubble variant="ghost" width="100%">
							<Steps parts={group.parts} message={message} streaming={streaming} onApproval={onApproval} />
						</ChatMessageBubble>
					</Fragment>
				);
			})}
			{used.length > 0 && <SourceList sources={used} />}
		</>
	);
}

function groupParts(parts: Part[]): Group[] {
	const groups: Group[] = [];
	for (const part of parts) {
		const last = groups[groups.length - 1];
		if (isStep(part) && last?.kind === "steps") last.parts.push(part);
		else if (isStep(part)) groups.push({ kind: "steps", parts: [part] });
		else if (part.type === "file" && last?.kind === "files") last.parts.push(part);
		else if (part.type === "file") groups.push({ kind: "files", parts: [part] });
		else if (part.type === "text") groups.push({ kind: "text", part });
	}
	return groups;
}

/**
 * Keys from part identity, not the group's place: answering an approval folds it into the
 * steps before it, so groups shift. A tool part is its call id; other parts are their place
 * in the message's parts, which only grows.
 */
function groupKey(group: Group, parts: Part[]) {
	const first = group.kind === "text" ? group.part : group.parts[0]!;
	return isTool(first) ? `steps:${first.toolCallId}` : `${group.kind}:${parts.indexOf(first)}`;
}

/** Attached files: images as pictures that open in the side panel, other files as chips. */
function Files({ parts }: { parts: FilePart[] }) {
	return (
		<div className="flex flex-wrap justify-end gap-2" data-slot="message-files">
			{parts.map((part, index) =>
				part.mediaType.startsWith("image/") && part.url ? (
					<Thumbnail
						key={index}
						src={part.url}
						alt={part.filename ?? "Image"}
						label={part.filename ?? "Image"}
						className="size-24"
						onClick={(event) => viewOrOpen(event, { name: part.filename ?? "Image", url: part.url, mediaType: part.mediaType })}
					/>
				) : (
					<FileChip key={index} name={part.filename ?? "File"} url={part.url} mediaType={part.mediaType} />
				),
			)}
		</div>
	);
}
