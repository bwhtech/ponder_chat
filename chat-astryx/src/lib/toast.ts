import { useToast, type ShowToastFn } from "@astryxdesign/core/Toast";
import { useEffect } from "react";

/**
 * Toasts from anywhere: a store or an async action outside React can call toast() and
 * toastError(). App mounts useToastBridge() once inside ToastViewport to connect them.
 */
let show: ShowToastFn | null = null;

export function useToastBridge() {
	const showToast = useToast();
	useEffect(() => {
		show = showToast;
		return () => {
			if (show === showToast) show = null;
		};
	}, [showToast]);
}

export function toast(body: string) {
	show?.({ body, type: "info" });
}

export function toastError(body: string) {
	show?.({ body, type: "error" });
}
