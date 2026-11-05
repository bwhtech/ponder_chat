<script setup lang="ts">
import { Alert, Button, debounce, Dialog, LoadingIndicator, Password, TextInput, toast } from "frappe-ui";
import { computed, reactive, ref, watch } from "vue";
import { settings } from "../settings/state";
import { addConnector, connectors, loadConnectors, probeServer, type Connector, type Header, type Probe } from "./api";
import ConnectorAvatar from "./ConnectorAvatar.vue";
import HeadersInput from "./HeadersInput.vue";
import { goToSignIn, openSignInWindow, waitForSignIn } from "./sign-in";

/**
 * Add connector: the URL of a remote MCP server. The server checks what it needs (no
 * sign-in, an API key or an OAuth sign-in) while the person types. OAuth opens the
 * server's sign-in in a new window, and the dialog waits for it to come back.
 */
const open = defineModel<boolean>("open", { default: false });

const phase = ref<"form" | "waiting" | "done">("form");
const error = ref("");
const cancelled = ref(false);
const waitingFor = ref("");
const added = ref<Connector | null>(null);
let cancelWaiting: (() => void) | undefined;

const form = reactive({ url: "", name: "", clientId: "", clientSecret: "" });
const headers = ref<Header[]>([]);
const advanced = ref(false);
const result = ref<Probe | null>(null);
const checking = ref(false);
const adding = ref(false);
let nameTyped = false;
let checked = "";

watch(open, (value) => {
	if (!value) {
		cancelWaiting?.();
		return;
	}
	Object.assign(form, { url: "", name: "", clientId: "", clientSecret: "" });
	headers.value = [];
	advanced.value = false;
	error.value = "";
	cancelled.value = false;
	result.value = null;
	phase.value = "form";
	added.value = null;
	nameTyped = false;
	checked = "";
});

// The server asks the URL what it needs, a moment after the person stops typing.
const check = debounce(async () => {
	const url = form.url.trim();
	if (!url || url === checked) return void (checking.value = false);
	checked = url;
	try {
		const probe = await probeServer(url);
		if (form.url.trim() !== url) return;
		result.value = probe;
		if (!probe.ok) return;
		if (!nameTyped) form.name = probe.name?.trim() || nameFrom(url);
		if (probe.auth === "headers" && !headers.value.length) headers.value = [{ name: "Authorization", value: "" }];
	} catch (problem) {
		result.value = { ok: false, message: problem instanceof Error ? problem.message : "Could not check the server." };
	} finally {
		if (form.url.trim() === url) checking.value = false;
	}
}, 600);

watch(
	() => form.url,
	(url) => {
		if (url.trim() === checked) return;
		result.value = null;
		checking.value = Boolean(url.trim());
		check();
	},
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
	const probe = result.value;
	if (!probe?.ok) return { icon: "lucide-circle-alert", tone: "text-ink-red-5" };
	return { icon: { oauth: "lucide-log-in", headers: "lucide-key-round", none: "lucide-circle-check" }[probe.auth], tone: "text-ink-gray-7" };
});

const canAdd = computed(() => {
	const probe = result.value;
	if (!probe?.ok || !form.name.trim() || adding.value) return false;
	if (probe.auth === "headers") return headers.value.some((row) => row.name.trim() && row.value.trim());
	return true;
});
const addLabel = computed(() => (result.value?.ok && result.value.auth === "oauth" ? "Connect" : "Add"));

async function add() {
	const probe = result.value;
	if (!probe?.ok) return;
	error.value = "";
	cancelled.value = false;
	const oauth = probe.auth === "oauth";
	// The popup opens in the click, so the browser allows it.
	const popup = oauth ? openSignInWindow() : null;
	adding.value = true;
	try {
		const answer = await addConnector({
			name: form.name.trim(),
			url: form.url.trim(),
			transport: probe.transport,
			auth: probe.auth,
			headers: headers.value.filter((row) => row.name.trim() || row.value.trim()),
			...(oauth && form.clientId.trim() && { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined }),
		});
		if ("connector" in answer) return finish(answer.connector);
		goToSignIn(popup, answer.authorizeUrl);
		if (popup) await waitForPopup(popup);
	} catch (problem) {
		popup?.close();
		phase.value = "form";
		error.value = problem instanceof Error ? problem.message : "The connector was not added.";
	} finally {
		adding.value = false;
	}
}

async function waitForPopup(popup: Window) {
	waitingFor.value = form.name.trim();
	phase.value = "waiting";
	const waiting = waitForSignIn(popup);
	cancelWaiting = waiting.cancel;
	const message = await waiting.result;
	cancelWaiting = undefined;
	if (!open.value) return;
	if (!message) {
		phase.value = "form";
		cancelled.value = true;
		return;
	}
	if (!message.ok) {
		phase.value = "form";
		error.value = message.error ?? "The sign-in did not finish.";
		return;
	}
	await loadConnectors();
	const connector = connectors.value?.find((each) => each.id === message.id);
	if (connector) finish(connector);
	else {
		open.value = false;
		toast.success("Connected");
	}
}

function finish(connector: Connector) {
	added.value = connector;
	phase.value = "done";
}

const doneText = computed(() => {
	const tools = added.value?.tools ?? [];
	const ask = tools.filter((tool) => tool.rule === "ask").length;
	if (!tools.length) return "The server lists no tools yet. Refresh its tools later, on its page.";
	if (!ask) return `${tools.length} tools. They only read, so Ponder uses them without asking.`;
	return `${tools.length} tools. Ponder uses the ${tools.length - ask} that only read, and asks you before it uses the other ${ask}.`;
});

function review() {
	settings.connector = added.value?.id ?? null;
	open.value = false;
}

const redirectUrl = `${location.origin}/oauth/mcp/callback`;
function copyRedirect() {
	void navigator.clipboard?.writeText(redirectUrl);
	toast.success("Copied the redirect URL");
}
</script>

<template>
	<Dialog v-model:open="open" :title="phase === 'done' ? '' : 'Add connector'" size="lg">
		<!-- Waiting for the sign-in window -->
		<div v-if="phase === 'waiting'" class="flex flex-col items-center gap-3 py-10 text-center" aria-live="polite">
			<div class="relative">
				<ConnectorAvatar :name="waitingFor" size="2xl" />
				<span class="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-surface-base shadow-sm">
					<LoadingIndicator class="size-4 text-ink-gray-6" />
				</span>
			</div>
			<p class="text-lg-semibold text-ink-gray-9">Sign in to {{ waitingFor }} in the new window</p>
			<p class="max-w-sm text-p-sm text-ink-gray-6">
				{{ waitingFor }} shows what Ponder may do. Ponder keeps the sign-in encrypted, and you can remove it at any time.
			</p>
			<Button variant="ghost" label="Cancel" @click="cancelWaiting?.()" />
		</div>

		<!-- Connected -->
		<div v-else-if="phase === 'done' && added" class="flex flex-col items-center gap-3 py-8 text-center" aria-live="polite">
			<div class="relative">
				<ConnectorAvatar :name="added.name" size="2xl" />
				<span class="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-surface-green-2 text-ink-green-6 shadow-sm">
					<span class="lucide-check size-3.5" aria-hidden="true" />
				</span>
			</div>
			<p class="text-lg-semibold text-ink-gray-9">{{ added.name }} is connected</p>
			<p class="max-w-sm text-p-sm text-ink-gray-6">{{ doneText }}</p>
			<div class="mt-2 flex gap-2">
				<Button label="Review tools" @click="review" />
				<Button variant="solid" theme="gray" label="Done" @click="open = false" />
			</div>
		</div>

		<!-- The form -->
		<form v-else class="space-y-4" @submit.prevent="canAdd && add()">
			<Alert v-if="cancelled" theme="amber" title="Sign-in cancelled" description="Nothing was saved. Connect again when you are ready." />
			<Alert v-if="error" theme="red" :title="error" />

			<div class="space-y-1.5">
				<TextInput v-model="form.url" label="Server URL" type="url" placeholder="https://mcp.example.com/mcp" required autocomplete="off" />
				<p v-if="checking" class="flex items-center gap-2 text-p-sm text-ink-gray-5">
					<LoadingIndicator class="size-3.5" /> Checking the server…
				</p>
				<p v-else-if="result" class="flex items-start gap-2 text-p-sm" :class="probeLine.tone" aria-live="polite">
					<span :class="probeLine.icon" class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<span>{{ result.message }}</span>
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
				<Button type="submit" variant="solid" theme="gray" :label="addLabel" :loading="adding" :disabled="!canAdd" />
			</div>
		</form>
	</Dialog>
</template>
