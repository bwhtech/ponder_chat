import { toast } from "./toasts";
import { dialog } from "./dialogs";
import { computed, onBeforeUnmount, watch } from "vue";
import { type Credits, me, refreshCredits } from "./account";
import { ApiError, client, unwrap } from "./api";

/**
 * Asking the admins for more credits, from the out-of-credits notice in the chat
 * (server/credits/ExtraCredits.ts). While a request waits, the page asks every 30 seconds, and
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

/** Confirms, then sends the request. A request that was already waiting (409) just shows as waiting. */
export function askForMoreCredits() {
	dialog.confirm({
		title: "Request more credits",
		message: "Ask the admins for more credits? This sends them a request with how much you've used today. You'll get an email when they answer.",
		confirmLabel: "Send request",
		onConfirm: async () => {
			await unwrap(client.api.credits.request.$post(), "The request could not be sent. Try again.").catch((error) => {
				if (!(error instanceof ApiError && error.status === 409)) throw error;
			});
			await refreshCredits();
		},
	});
}

/** For the signed-in shell: follows a waiting request until it is answered. */
export function useCreditRequestWatch() {
	const pending = computed(() => me.value?.credits.request?.status === "pending");
	let timer: ReturnType<typeof setInterval> | undefined;
	const onFocus = () => void refreshCredits();
	const stop = () => {
		clearInterval(timer);
		removeEventListener("focus", onFocus);
	};

	watch(
		pending,
		(waiting) => {
			stop();
			if (!waiting) return;
			timer = setInterval(onFocus, POLL_MS);
			addEventListener("focus", onFocus);
		},
		{ immediate: true },
	);
	watch(
		() => me.value?.credits.request,
		(request, before) => {
			if (before?.status === "pending" && request?.status === "approved") {
				toast.success(`You got ${request.credits} more credits for today`);
			}
		},
	);
	onBeforeUnmount(stop);
}
