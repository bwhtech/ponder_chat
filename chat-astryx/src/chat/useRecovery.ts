import type { ChatStatus, UIMessage } from "ai";
import { useEffect, useRef, useState, type RefObject } from "react";
import { repliedOnServer, type Failure } from "../lib/threads";
import { toastError } from "../lib/toast";

/** What recovery needs from useChat. */
type Chat = {
	status: ChatStatus;
	setMessages: (messages: UIMessage[]) => void;
	sendMessage: () => Promise<void>;
	regenerate: () => Promise<void>;
	resumeStream: () => Promise<void>;
	clearError: () => void;
};

type RecoveryOptions = {
	threadId: string;
	/** The reply was still being written when the thread loaded: follow it. */
	running: boolean;
	chat: Chat;
	/** The messages the run this chat follows started from (ChatView). */
	base: RefObject<UIMessage[]>;
	/** The reply failed before the chat last closed (threads.ts): Retry is offered again. */
	failure: Failure | undefined;
	/** Retry found the reply finished on the server: its place in the list and the credits changed. */
	onSaved: () => void;
};

/**
 * Following a reply again: after a reload, and on Retry after an error. Both wait for the
 * server before the SDK's status changes, so until then `pending` is true and the chat
 * counts as busy: for the composer, the queue, the list's revalidation (chatBusy) and what
 * is kept when the chat closes.
 *
 * Retry first asks the server what became of the reply. One that still runs is followed
 * again; one the server finished is shown; otherwise what failed is sent again: the
 * person's message (regenerate), or an answered approval, which carries on its message.
 * A reply that failed before the chat closed comes back as `failure`, with Retry.
 */
export function useRecovery({ threadId, running, chat, base, failure, onSaved }: RecoveryOptions) {
	const latest = useRef({ chat, onSaved });
	latest.current = { chat, onSaved };
	const restoredRef = useRef(failure);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Reconnecting to the run, until the replay ends.
	const [following, setFollowing] = useState(running);
	const follows = useRef(0);
	async function follow() {
		const token = ++follows.current;
		setFollowing(true);
		try {
			await latest.current.chat.resumeStream();
		} finally {
			if (token === follows.current) setFollowing(false);
		}
	}
	useEffect(() => {
		if (running) void follow();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A failure from before the chat closed, until a reply starts: the chat acts as after an error.
	const [restored, setRestored] = useState(failure);
	restoredRef.current = restored;
	const busy = chat.status === "submitted" || chat.status === "streaming";
	useEffect(() => {
		if (busy) setRestored(undefined);
	}, [busy]);

	// Retry asking the server: one at a time. Its token, or null; Stop drops it (cancel).
	const [checking, setChecking] = useState(false);
	const check = useRef<number | null>(null);
	const checks = useRef(0);

	/** Stop: an answer still on its way for Retry is dropped, so it cannot start a reply after Stop. */
	function cancel() {
		if (check.current === null) return;
		check.current = null;
		setChecking(false);
	}

	async function retry() {
		if (check.current !== null) return;
		const token = ++checks.current;
		check.current = token;
		setChecking(true);
		const thread = await serverThread(threadId);
		if (check.current !== token) return;
		check.current = null;
		setChecking(false);
		const { chat } = latest.current;
		// The chat closed, or a reply started meanwhile (an approval answered, say).
		if (!mounted.current || (chat.status !== "error" && !restoredRef.current)) return;
		if (!thread) return toastError("Ponder Chat could not reach the server. Try again.");
		setRestored(undefined);
		if (thread.running) return follow();
		if (repliedOnServer(thread.messages, base.current)) {
			base.current = thread.messages;
			chat.setMessages(thread.messages);
			chat.clearError();
			latest.current.onSaved();
			return;
		}
		// Nothing ran: send the same messages again. A thread that ends on an assistant message
		// carried on that message (an approval was answered), so it is sent again as it was.
		const sent = base.current;
		if (!sent.length) return chat.clearError();
		chat.setMessages(sent);
		if (sent[sent.length - 1].role === "assistant") await chat.sendMessage();
		else await chat.regenerate();
	}

	return { pending: following || checking, failure: restored, retry, cancel };
}

/** The server's copy of the thread, or null when it could not be reached. */
async function serverThread(threadId: string): Promise<{ messages: UIMessage[]; running: boolean } | null> {
	try {
		const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { cache: "no-store" });
		if (!response.ok) return null;
		const body = (await response.json()) as { messages?: UIMessage[]; running?: boolean };
		return { messages: body.messages ?? [], running: Boolean(body.running) };
	} catch {
		return null;
	}
}
