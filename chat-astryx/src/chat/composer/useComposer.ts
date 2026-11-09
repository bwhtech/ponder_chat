import type { ChatComposerInputHandle } from "@astryxdesign/core/Chat";
import type { ChatStatus, FileUIPart, UIMessage } from "ai";
import { useRef, useState, type RefObject } from "react";
import { citationLabel, citationPart, withComment, type Citation } from "../../cite/citations";
import { useDraft } from "../../lib/drafts";
import { closeOpenCalls, useMessageQueue, type Queued } from "../../lib/message-queue";
import { features } from "../../lib/models";
import { useStore } from "../../lib/store";
import { added } from "../../lib/threads";
import { useSkillPicker } from "../../skills/picker";
import { skillPart, skillTitle } from "../../skills/skills";
import { acceptList, matchesAccept, uploadFiles } from "./files";
import { useCiteChips } from "./useCiteChips";

type SendMessage = (message: { text: string; files?: FileUIPart[] } | { parts: UIMessage["parts"] }) => Promise<void>;

export type ComposerOptions = {
	threadId: string;
	/** The conversation, where Cite looks for selected reply text. */
	area: RefObject<HTMLElement | null>;
	messages: UIMessage[];
	setMessages: (messages: UIMessage[]) => void;
	sendMessage: SendMessage;
	status: ChatStatus;
	stopRun: () => Promise<unknown>;
	outOfCredits: boolean;
	/** Renders older messages, for a quote above the ones on screen; false when there are none left. */
	showEarlier?: () => boolean;
};

/**
 * Writing and sending a message: the text (kept as a draft per thread), attached files,
 * chosen skills, quotes, and the queue of messages written while a reply streams.
 */
export function useComposer({ threadId, area, messages, setMessages, sendMessage, status, stopRun, outOfCredits, showEarlier }: ComposerOptions) {
	// What the person was writing in this chat comes back after a switch or a reload.
	const [input, setInput] = useDraft(threadId);
	const [files, setFiles] = useState<File[]>([]);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState("");
	const field = useRef<ChatComposerInputHandle>(null);
	const skills = useSkillPicker();
	const cites = useCiteChips(area, () => field.current?.focus(), showEarlier);
	const accept = acceptList(useStore(features).python);
	const latest = useRef(messages);
	latest.current = messages;

	const busy = status === "submitted" || status === "streaming";
	const disabled = uploading || outOfCredits;
	// Messages written while a reply streams wait here; the first goes out when it ends (message-queue.ts).
	const queue = useMessageQueue(threadId, { busy, ready: status === "ready", outOfCredits, send: sendNow, stopReply: stopRun });
	const canSubmit = !disabled && (input.trim() !== "" || files.length > 0 || skills.chosen.length > 0 || cites.chips.length > 0);

	/** While a reply streams, the message is queued; otherwise it goes out now. `quotes` stand in for the chips when a comment was just saved. */
	async function send(text = input.trim(), quotes?: Citation[]) {
		if (disabled || (!text.trim() && !files.length && !skills.chosen.length && !cites.chips.length)) return;
		const attached = files;
		const chosen = skills.take();
		const quoted = quotes ?? cites.chips;
		cites.take();
		setInput("");
		setFiles([]);
		// What did not go out comes back to the field: the text, the chosen skills and the quotes.
		const giveBack = () => {
			setInput((now) => now || text);
			skills.restore((now) => (now.length ? now : chosen));
			cites.restore((now) => (now.length ? now : quoted));
		};
		const uploaded = await upload(attached);
		// The field cleared on submit; give the text back so only the files need attaching again.
		if (!uploaded) return giveBack();
		await queue.send({ id: crypto.randomUUID(), text, files: uploaded, skills: chosen, citations: quoted });
	}

	function sendNow({ text, files, skills: chosen, citations: quoted }: Queued) {
		const closed = closeOpenCalls(latest.current);
		if (closed) setMessages(closed);
		// The first message: the thread shows in the list now, not once the reply ends. Files alone
		// leave it untitled ("New chat"), as the server names it, until it gets a title.
		if (!latest.current.some((message) => message.role === "user")) added(threadId, text || chosen.map(skillTitle).join(", ") || (quoted[0] ? citationLabel(quoted[0]) : ""));
		if (!chosen.length && !quoted.length) return sendMessage(files.length ? { text, files } : { text });
		// The skills go first in the message, so their instructions come before the person's text (server/workflow/skills.ts).
		// The quotes come next, so the text that follows can refer to them (server/workflow/citations.ts).
		return sendMessage({
			parts: [...files, ...chosen.map(skillPart), ...quoted.map(citationPart), ...(text ? [{ type: "text" as const, text }] : [])] as UIMessage["parts"],
		});
	}

	/** Uploads the attached files; the message carries links to them. Returns null if any failed. */
	async function upload(attached: File[]): Promise<FileUIPart[] | null> {
		setUploadError("");
		if (!attached.length) return [];
		setUploading(true);
		try {
			return await uploadFiles(attached);
		} catch (error) {
			setUploadError(error instanceof Error ? error.message : String(error));
			return null;
		} finally {
			setUploading(false);
		}
	}

	function attach(more: File[]) {
		if (disabled) return;
		const accepted = more.filter((file) => matchesAccept(file, accept));
		if (accepted.length) setFiles((now) => [...now, ...accepted]);
	}

	/** Cmd/Ctrl+Enter in a quote's comment: save it, then send what the field holds. */
	function saveAndSend(index: number, comment: string) {
		const quotes = cites.chips.map((citation, at) => (at === index ? withComment(citation, comment) : citation));
		cites.save(index, comment);
		void send(input.trim(), quotes);
	}

	return {
		field,
		input,
		setInput,
		files,
		attach,
		removeFile: (file: File) => setFiles((now) => now.filter((each) => each !== file)),
		accept,
		uploading,
		uploadError,
		busy,
		disabled,
		canSubmit,
		send,
		skills,
		cites,
		saveAndSend,
		queue,
	};
}

export type ComposerState = ReturnType<typeof useComposer>;
