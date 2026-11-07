<script setup lang="ts">
import { Alert, Button, debounce, Dialog, LoadingIndicator, Password, TextInput, toast } from "frappe-ui";
import { computed, reactive, ref, watch } from "vue";
import { settings } from "../settings/state";
import { addConnector, connectors, loadConnectors, probeServer, type Connector, type Header, type Probe, type SignInMessage } from "./api";
import ConnectorAvatar from "./ConnectorAvatar.vue";
import HeadersInput from "./HeadersInput.vue";
import { goToSignIn, openSignInWindow, waitForSignIn } from "./sign-in";

/**
 * Add connector: the URL of a remote MCP server. The server checks what it needs (no
 * sign-in, an API key or an OAuth sign-in) while the person types. OAuth opens the
 * server's sign-in in a new window, and the dialog waits for it to come back.
 */
const open = defineModel<boolean>("open", { default: false });

type Found = Extract<Probe, { ok: true }>;
/** What the server said about the URL. Each state names its URL, so an answer for an older URL is dropped. */
type Check = { kind: "idle" } | { kind: "checking"; url: string } | { kind: "ok"; url: string; found: Found } | { kind: "failed"; url: string; message: string };
/** Why the form shows again. One at a time. */
type Notice = { kind: "cancelled" } | { kind: "closed" } | { kind: "error"; message: string };
type Step = { kind: "form"; notice: Notice | null } | { kind: "adding" } | { kind: "waiting"; name: string } | { kind: "done"; connector: Connector };

const step = ref<Step>({ kind: "form", notice: null });
const probe = ref<Check>({ kind: "idle" });
const form = reactive({ url: "", name: "", clientId: "", clientSecret: "" });
const headers = ref<Header[]>([]);
const advanced = ref(false);
let nameTyped = false;
// Only answers that found a server are kept: a failed check runs again.
const found = new Map<string, Found>();
let probes = 0;
// The newest add. Closing the dialog, Cancel and a new add abort it, and an aborted add changes nothing here.
let attempt: AbortController | undefined;

watch(open, (value) => {
	attempt?.abort();
	attempt = undefined;
	check.cancel();
	if (!value) return;
	Object.assign(form, { url: "", name: "", clientId: "", clientSecret: "" });
	headers.value = [];
	advanced.value = false;
	step.value = { kind: "form", notice: null };
	probe.value = { kind: "idle" };
	found.clear();
	nameTyped = false;
});

// The server asks the URL what it needs, a moment after the person stops typing.
const check = debounce(async (url: string) => {
	const mine = ++probes;
	const current = () => mine === probes && probe.value.kind === "checking" && probe.value.url === url;
	try {
		const answer = await probeServer(url);
		if (!current()) return;
		if (!answer.ok) return void (probe.value = { kind: "failed", url, message: answer.message });
		found.set(url, answer);
		use(url, answer);
	} catch (problem) {
		if (current()) probe.value = { kind: "failed", url, message: problem instanceof Error ? problem.message : "Could not check the server." };
	}
}, 600);

function use(url: string, answer: Found) {
	probe.value = { kind: "ok", url, found: answer };
	if (!nameTyped) form.name = answer.name?.trim() || nameFrom(url);
	if (answer.auth === "headers" && !headers.value.length) headers.value = [{ name: "Authorization", value: "" }];
}

function checkUrl() {
	const url = form.url.trim();
	check.cancel();
	probes++;
	if (!url) return void (probe.value = { kind: "idle" });
	const known = found.get(url);
	if (known) return use(url, known);
	probe.value = { kind: "checking", url };
	check(url);
}

watch(
	() => form.url,
	(url, before) => url.trim() !== before?.trim() && checkUrl(),
);

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

const probeLine = computed(() => {
	const answer = probe.value;
	if (answer.kind !== "ok") return { icon: "lucide-circle-alert", tone: "text-ink-red-5" };
	return { icon: { oauth: "lucide-log-in", headers: "lucide-key-round", none: "lucide-circle-check" }[answer.found.auth], tone: "text-ink-gray-7" };
});
/** The server's answer, when it found one. */
const result = computed(() => (probe.value.kind === "ok" ? probe.value.found : null));

const canAdd = computed(() => {
	const answer = result.value;
	if (!answer || !form.name.trim() || step.value.kind !== "form") return false;
	if (answer.auth === "headers") return headers.value.some((row) => row.name.trim() && row.value.trim());
	return true;
});
const addLabel = computed(() => (result.value?.auth === "oauth" ? "Connect" : "Add"));

async function add() {
	const answer = result.value;
	if (!answer || step.value.kind !== "form") return;
	const oauth = answer.auth === "oauth";
	// The popup opens in the click, so the browser allows it.
	const popup = oauth ? openSignInWindow() : null;
	attempt?.abort();
	const stop = new AbortController();
	attempt = stop;
	stop.signal.addEventListener("abort", () => popup?.close(), { once: true });
	const live = () => attempt === stop && !stop.signal.aborted;
	const name = form.name.trim();
	step.value = { kind: "adding" };
	try {
		const added = await addConnector({
			name,
			url: form.url.trim(),
			transport: answer.transport,
			auth: answer.auth,
			headers: headers.value.filter((row) => row.name.trim() || row.value.trim()),
			...(oauth && form.clientId.trim() && { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined }),
		});
		// The dialog closed meanwhile. A connector that needed no sign-in is in the list (api.ts).
		if (!live()) return;
		if ("connector" in added) {
			// The server did not need the sign-in after all.
			popup?.close();
			return finish(added.connector);
		}
		goToSignIn(popup, added.authorizeUrl);
		// No popup: this tab goes to the sign-in page.
		if (!popup) return;
		step.value = { kind: "waiting", name };
		const end = await waitForSignIn(popup, {
			authorizeUrl: added.authorizeUrl,
			signal: stop.signal,
			// The popup only looked closed (sign-in.ts): the answer still counts.
			onLate: (message) => void (live() && signedIn(message, live)),
		});
		if (!live()) return;
		if (end.kind === "answered") await signedIn(end.message, live);
		else step.value = { kind: "form", notice: { kind: end.kind === "closed" ? "closed" : "cancelled" } };
	} catch (problem) {
		popup?.close();
		if (live()) step.value = { kind: "form", notice: { kind: "error", message: problem instanceof Error ? problem.message : "The connector was not added." } };
	}
}

function cancelWaiting() {
	step.value = { kind: "form", notice: { kind: "cancelled" } };
	attempt?.abort();
	attempt = undefined;
}

async function signedIn(message: SignInMessage, live: () => boolean) {
	if (!message.ok) return void (step.value = { kind: "form", notice: { kind: "error", message: message.error ?? "The sign-in did not finish." } });
	await loadConnectors().catch(() => undefined);
	if (!live()) return;
	const connector = connectors.value?.find((each) => each.id === message.id);
	if (connector) finish(connector);
	else {
		open.value = false;
		toast.success("Connected");
	}
}

function finish(connector: Connector) {
	step.value = { kind: "done", connector };
}

const doneText = computed(() => {
	const tools = step.value.kind === "done" ? step.value.connector.tools : [];
	const ask = tools.filter((tool) => tool.rule === "ask").length;
	if (!tools.length) return "The server lists no tools yet. Refresh its tools later, on its page.";
	if (!ask) return `${tools.length} tools. They only read, so Ponder uses them without asking.`;
	return `${tools.length} tools. Ponder uses the ${tools.length - ask} that only read, and asks you before it uses the other ${ask}.`;
});

function review() {
	if (step.value.kind === "done") settings.connector = step.value.connector.id;
	open.value = false;
}

const redirectUrl = `${location.origin}/oauth/mcp/callback`;
function copyRedirect() {
	void navigator.clipboard?.writeText(redirectUrl);
	toast.success("Copied the redirect URL");
}
</script>

<template>
	<Dialog v-model:open="open" :title="step.kind === 'done' ? '' : 'Add connector'" size="lg">
		<!-- Waiting for the sign-in window -->
		<div v-if="step.kind === 'waiting'" class="flex flex-col items-center gap-3 py-10 text-center" aria-live="polite">
			<div class="relative">
				<ConnectorAvatar :name="step.name" size="2xl" />
				<span class="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-surface-base shadow-sm">
					<LoadingIndicator class="size-4 text-ink-gray-6" />
				</span>
			</div>
			<p class="text-lg-semibold text-ink-gray-9">Sign in to {{ step.name }} in the new window</p>
			<p class="max-w-sm text-p-sm text-ink-gray-6">
				{{ step.name }} shows what Ponder may do. Ponder keeps the sign-in encrypted, and you can remove it at any time.
			</p>
			<Button variant="ghost" label="Cancel" @click="cancelWaiting" />
		</div>

		<!-- Connected -->
		<div v-else-if="step.kind === 'done'" class="flex flex-col items-center gap-3 py-8 text-center" aria-live="polite">
			<div class="relative">
				<ConnectorAvatar :name="step.connector.name" size="2xl" />
				<span class="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-surface-green-2 text-ink-green-6 shadow-sm">
					<span class="lucide-check size-3.5" aria-hidden="true" />
				</span>
			</div>
			<p class="text-lg-semibold text-ink-gray-9">{{ step.connector.name }} is connected</p>
			<p class="max-w-sm text-p-sm text-ink-gray-6">{{ doneText }}</p>
			<div class="mt-2 flex gap-2">
				<Button label="Review tools" @click="review" />
				<Button variant="solid" theme="gray" label="Done" @click="open = false" />
			</div>
		</div>

		<!-- The form -->
		<form v-else class="space-y-4" @submit.prevent="canAdd && add()">
			<template v-if="step.kind === 'form' && step.notice">
				<Alert v-if="step.notice.kind === 'cancelled'" theme="amber" title="Sign-in cancelled" description="Nothing was saved. Connect again when you are ready." />
				<Alert
					v-else-if="step.notice.kind === 'closed'"
					theme="amber"
					title="The sign-in window closed"
					description="Connect again when you are ready. If you finished signing in, the connector shows here in a moment."
				/>
				<Alert v-else theme="red" :title="step.notice.message" />
			</template>

			<div class="space-y-1.5">
				<TextInput v-model="form.url" label="Server URL" type="url" placeholder="https://mcp.example.com/mcp" required autocomplete="off" />
				<p v-if="probe.kind === 'checking'" class="flex items-center gap-2 text-p-sm text-ink-gray-5">
					<LoadingIndicator class="size-3.5" /> Checking the server…
				</p>
				<p v-else-if="probe.kind !== 'idle'" class="flex items-start gap-2 text-p-sm" :class="probeLine.tone" aria-live="polite">
					<span :class="probeLine.icon" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>{{ probe.kind === "ok" ? probe.found.message : probe.message }}</span>
					<Button v-if="probe.kind === 'failed'" variant="ghost" size="sm" label="Check again" class="-my-1 ml-auto shrink-0" @click="checkUrl" />
				</p>
				<p v-else class="text-p-sm text-ink-gray-5">The address of a remote MCP server. Ponder checks what it needs.</p>
			</div>

			<TextInput
				v-model="form.name"
				label="Name"
				description="How the connector shows in Ponder and in its tool calls."
				required
				maxlength="60"
				@input="nameTyped = true"
			/>

			<div v-if="result?.ok && result.auth === 'headers'" class="space-y-1.5">
				<p class="text-sm text-ink-gray-6">API key</p>
				<HeadersInput v-model="headers" />
				<p class="text-p-sm text-ink-gray-5">Saved encrypted. Ponder sends it only to this server and never shows it again.</p>
			</div>

			<div>
				<Button
					variant="ghost"
					size="sm"
					:icon-left="advanced ? 'lucide-chevron-down' : 'lucide-chevron-right'"
					label="Advanced"
					:aria-expanded="advanced"
					@click="advanced = !advanced"
				/>
				<div v-if="advanced" class="mt-3 space-y-5 rounded-5 border border-outline-gray-2 p-4">
					<div v-if="!result?.ok || result.auth === 'oauth'" class="space-y-3">
						<div>
							<p class="text-base-medium text-ink-gray-8">Your own OAuth app</p>
							<p class="text-p-sm text-ink-gray-5">
								Only for a server that does not let Ponder register itself, such as GitHub. Register an app there with this redirect URL, then enter its ID and secret.
							</p>
						</div>
						<div class="flex items-center gap-1 rounded-4 bg-surface-gray-1 px-2.5 py-1.5">
							<span class="min-w-0 flex-1 truncate font-mono text-xs text-ink-gray-7">{{ redirectUrl }}</span>
							<Button variant="ghost" size="sm" icon="lucide-copy" aria-label="Copy the redirect URL" @click="copyRedirect" />
						</div>
						<div class="grid gap-3 sm:grid-cols-2">
							<TextInput v-model="form.clientId" label="Client ID" autocomplete="off" />
							<Password v-model="form.clientSecret" label="Client secret" autocomplete="off" />
						</div>
					</div>
					<div v-if="!result?.ok || result.auth !== 'headers'" class="space-y-3">
						<div>
							<p class="text-base-medium text-ink-gray-8">Headers</p>
							<p class="text-p-sm text-ink-gray-5">Sent with every request to this server. Saved encrypted.</p>
						</div>
						<HeadersInput v-model="headers" />
					</div>
				</div>
			</div>

			<p class="text-p-sm text-ink-gray-5">Only add servers you trust. Ponder runs their tools with your sign-in, and what they return goes to the model.</p>

			<div class="flex justify-end gap-2 pt-2">
				<Button label="Cancel" @click="open = false" />
				<Button type="submit" variant="solid" theme="gray" :label="addLabel" :loading="step.kind === 'adding'" :disabled="!canAdd" />
			</div>
		</form>
	</Dialog>
</template>
