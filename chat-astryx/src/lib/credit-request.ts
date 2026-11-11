import { useEffect, useRef } from "react";
import { type Credits, me, refreshCredits } from "./account";
import { ApiError, request } from "./api";
import { useStore } from "./store";
import { toast } from "./toast";

/**
 * Asking the admins for more credits, from the out-of-credits notice in the chat
 * (server/extra-credits.ts). While a request waits, the page asks every 30 seconds, and
 * when the window gets focus, whether it was answered. An approval raises today's limit,
 * so the notice goes away and a toast says how many credits came.
 */
const POLL_MS = 30_000;

/** The out-of-credits notice: what it says, and whether the person can ask for more. */
export function outOfCreditsNotice(credits: Credits | undefined, refillTime: string) {
	const status = credits?.request?.status;
	if (status === "pending") {
		return {
			description: `Your request for more credits was sent and is waiting for an admin. You'll get an email when they answer. Credits refill at ${refillTime}.`,
			canAsk: false,
		};
	}
	if (status === "declined") {
		return { description: `An admin declined your request for more credits today. They refill at ${refillTime}. You can ask again.`, canAsk: true };
	}
	return { description: `They refill at ${refillTime}. Your chats are saved, and you can keep reading them.`, canAsk: true };
}

/** Sends the request, once the person confirmed. A request that was already waiting (409) just shows as waiting. */
export async function askForMoreCredits() {
	await request("/api/credits/request", { method: "POST", failure: "The request could not be sent. Try again." }).catch((error) => {
		if (!(error instanceof ApiError && error.status === 409)) throw error;
	});
	await refreshCredits();
}

/** Follows a waiting request until it is answered. */
export function useCreditRequestWatch() {
	const answer = useStore(me)?.credits.request;
	const pending = answer?.status === "pending";
	const before = useRef(answer);

	useEffect(() => {
		if (!pending) return;
		const onFocus = () => void refreshCredits().catch(() => undefined);
		const timer = setInterval(onFocus, POLL_MS);
		addEventListener("focus", onFocus);
		return () => {
			clearInterval(timer);
			removeEventListener("focus", onFocus);
		};
	}, [pending]);

	useEffect(() => {
		if (before.current?.status === "pending" && answer?.status === "approved") toast(`You got ${answer.credits} more credits for today`);
		before.current = answer;
	}, [answer]);
}
