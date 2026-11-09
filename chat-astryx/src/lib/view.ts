import { createStore } from "./store";

/** The main area shows the open chat, or the Memory page (?view=memory). */
export type View = "chat" | "memory";

export const view = createStore<View>(viewInUrl());
addEventListener("popstate", () => view.set(viewInUrl()));

function viewInUrl(): View {
	return new URL(location.href).searchParams.get("view") === "memory" ? "memory" : "chat";
}

export function showChat() {
	if (view.get() === "chat") return;
	view.set("chat");
	const url = new URL(location.href);
	url.searchParams.delete("view");
	history.replaceState(null, "", url);
}

export function showMemory() {
	if (view.get() === "memory") return;
	view.set("memory");
	const url = new URL(location.href);
	url.searchParams.set("view", "memory");
	history.pushState(null, "", url);
}
