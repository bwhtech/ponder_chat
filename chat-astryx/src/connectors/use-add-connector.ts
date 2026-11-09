import { useEffect, useRef, useState } from "react";
import { toast } from "../lib/toast";
import { showConnector } from "../settings/state";
import { addConnector, connectors, loadConnectors, probeServer, type Connector, type Header, type Probe, type SignInMessage } from "./api";
import { goToSignIn, openSignInWindow, waitForSignIn } from "./sign-in";

/**
 * Add connector: the URL of a remote MCP server. The server checks what it needs (no
 * sign-in, an API key or an OAuth sign-in) while the person types. OAuth opens the
 * server's sign-in in a new window, and the page waits for it to come back.
 */
export type Found = Extract<Probe, { ok: true }>;
/** What the server said about the URL. Each state names its URL, so an answer for an older URL is dropped. */
export type Check = { kind: "idle" } | { kind: "checking"; url: string } | { kind: "ok"; url: string; found: Found } | { kind: "failed"; url: string; message: string };
/** Why the form shows again. One at a time. */
export type Notice = { kind: "cancelled" } | { kind: "closed" } | { kind: "error"; message: string };
export type Step = { kind: "form"; notice: Notice | null } | { kind: "adding" } | { kind: "waiting"; name: string } | { kind: "done"; connector: Connector };
export type Form = { url: string; name: string; clientId: string; clientSecret: string };

export function useAddConnector() {
	const [step, setStep] = useState<Step>({ kind: "form", notice: null });
	const [probe, setProbeState] = useState<Check>({ kind: "idle" });
	const [form, setForm] = useState<Form>({ url: "", name: "", clientId: "", clientSecret: "" });
	const [headers, setHeaders] = useState<Header[]>([]);
	const probeNow = useRef(probe);
	const nameTyped = useRef(false);
	// Only answers that found a server are kept: a failed check runs again.
	const found = useRef(new Map<string, Found>());
	const probes = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	// The newest add. Leaving the page, Cancel and a new add abort it, and an aborted add changes nothing here.
	const attempt = useRef<AbortController>(undefined);

	useEffect(
		() => () => {
			attempt.current?.abort();
			clearTimeout(timer.current);
		},
		[],
	);

	function setProbe(next: Check) {
		probeNow.current = next;
		setProbeState(next);
	}

	function use(url: string, answer: Found) {
		setProbe({ kind: "ok", url, found: answer });
		if (!nameTyped.current) setForm((before) => ({ ...before, name: answer.name?.trim() || nameFrom(url) }));
		if (answer.auth === "headers") setHeaders((rows) => (rows.length ? rows : [{ name: "Authorization", value: "" }]));
	}

	// The server asks the URL what it needs, a moment after the person stops typing.
	async function check(url: string) {
		const mine = ++probes.current;
		const current = () => mine === probes.current && probeNow.current.kind === "checking" && probeNow.current.url === url;
		try {
			const answer = await probeServer(url);
			if (!current()) return;
			if (!answer.ok) return setProbe({ kind: "failed", url, message: answer.message });
			found.current.set(url, answer);
			use(url, answer);
		} catch (problem) {
			if (current()) setProbe({ kind: "failed", url, message: problem instanceof Error ? problem.message : "Could not check the server." });
		}
	}

	function checkUrl(raw = form.url) {
		const url = raw.trim();
		clearTimeout(timer.current);
		probes.current++;
		if (!url) return setProbe({ kind: "idle" });
		const known = found.current.get(url);
		if (known) return use(url, known);
		setProbe({ kind: "checking", url });
		timer.current = setTimeout(() => void check(url), 600);
	}

	function setUrl(url: string) {
		const before = form.url;
		setForm((current) => ({ ...current, url }));
		if (url.trim() !== before.trim()) checkUrl(url);
	}

	function setName(name: string) {
		nameTyped.current = true;
		setForm((current) => ({ ...current, name }));
	}

	const result = probe.kind === "ok" ? probe.found : null;
	const canAdd = (() => {
		if (!result || !form.name.trim() || step.kind !== "form") return false;
		if (result.auth === "headers") return headers.some((row) => row.name.trim() && row.value.trim());
		return true;
	})();

	async function add() {
		const answer = result;
		if (!answer || step.kind !== "form") return;
		const oauth = answer.auth === "oauth";
		// The popup opens in the click, so the browser allows it.
		const popup = oauth ? openSignInWindow() : null;
		attempt.current?.abort();
		const stop = new AbortController();
		attempt.current = stop;
		stop.signal.addEventListener("abort", () => popup?.close(), { once: true });
		const live = () => attempt.current === stop && !stop.signal.aborted;
		const name = form.name.trim();
		setStep({ kind: "adding" });
		try {
			const added = await addConnector({
				name,
				url: form.url.trim(),
				transport: answer.transport,
				auth: answer.auth,
				headers: headers.filter((row) => row.name.trim() || row.value.trim()),
				...(oauth && form.clientId.trim() && { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined }),
			});
			// The page closed meanwhile. A connector that needed no sign-in is in the list (api.ts).
			if (!live()) return;
			if ("connector" in added) {
				// The server did not need the sign-in after all.
				popup?.close();
				return setStep({ kind: "done", connector: added.connector });
			}
			goToSignIn(popup, added.authorizeUrl);
			// No popup: this tab goes to the sign-in page.
			if (!popup) return;
			setStep({ kind: "waiting", name });
			const end = await waitForSignIn(popup, {
				authorizeUrl: added.authorizeUrl,
				signal: stop.signal,
				// The popup only looked closed (sign-in.ts): the answer still counts.
				onLate: (message) => void (live() && signedIn(message, live)),
			});
			if (!live()) return;
			if (end.kind === "answered") await signedIn(end.message, live);
			else setStep({ kind: "form", notice: { kind: end.kind === "closed" ? "closed" : "cancelled" } });
		} catch (problem) {
			popup?.close();
			if (live()) setStep({ kind: "form", notice: { kind: "error", message: problem instanceof Error ? problem.message : "The connector was not added." } });
		}
	}

	function cancelWaiting() {
		setStep({ kind: "form", notice: { kind: "cancelled" } });
		attempt.current?.abort();
		attempt.current = undefined;
	}

	async function signedIn(message: SignInMessage, live: () => boolean) {
		if (!message.ok) return setStep({ kind: "form", notice: { kind: "error", message: message.error ?? "The sign-in did not finish." } });
		await loadConnectors().catch(() => undefined);
		if (!live()) return;
		const connector = connectors.get()?.find((each) => each.id === message.id);
		if (connector) return setStep({ kind: "done", connector });
		showConnector(null);
		toast("Connected");
	}

	return { step, probe, form, setForm, setUrl, setName, headers, setHeaders, result, canAdd, checkUrl, add, cancelWaiting };
}

/** "mcp.linear.app" gives "Linear". */
function nameFrom(address: string) {
	try {
		const host = new URL(address).hostname;
		// An IP address names nothing.
		if (/^[\d.]+$|^\[|:/.test(host)) return "";
		const word = host.replace(/^(mcp|api|www)\./, "").split(".")[0] ?? "";
		return word ? word[0]!.toUpperCase() + word.slice(1) : "";
	} catch {
		return "";
	}
}
