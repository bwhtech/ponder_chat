<script setup lang="ts">
import type { UIMessage } from "ai";
import { provideToolLabels, provideToolRenderers } from "frappe-ui-ai-elements";
import ArtifactPart from "./artifacts/ArtifactPart.vue";
import { connectors, loadConnectors } from "./connectors/api";
import { connectorLabel } from "./connectors/labels";
import { fetchApprovalQuestion } from "./fetch-approval";
import { provideCardSend } from "./genui/actions";
import ShowUiPart from "./genui/ShowUiPart.vue";
import RunPythonPart from "./RunPythonPart.vue";
import UseSkillPart from "./skills/UseSkillPart.vue";
import WebToolPart from "./WebToolPart.vue";

/**
 * How a chat's replies show their tool calls, for the transcript inside it (ChatView.vue).
 * Part of the transcript's chunk: a new chat, with no replies, loads none of it.
 *
 * A Python run shows its code, what it printed, and the files it made. Searches and page
 * reads are one line each, so they fold with the steps around them. A skill Ponder chose
 * (use_skill) stays a line of its own, so the person sees which skill shaped the reply. An
 * artifact (write_artifact) is a card that opens it in the side panel. Connector steps show
 * as "Linear · Create issue", and a search as what it looked for (connectors/labels.ts). A card
 * (show_ui) draws in the reply, and its buttons send messages through `send`.
 */
const props = defineProps<{ messages: UIMessage[]; send?: (text: string) => void }>();

// Only a chat with messages shows connector steps, and this mounts with the first message: the connectors load now.
if (!connectors.value) void loadConnectors().catch(() => undefined);

provideToolRenderers(
	{ run_python: RunPythonPart, web_search: WebToolPart, web_fetch: WebToolPart, use_skill: UseSkillPart, write_artifact: ArtifactPart, show_ui: ShowUiPart },
	{ foldable: ["web_search", "web_fetch"] },
);
provideCardSend((text) => props.send?.(text));
provideToolLabels((name, part) => {
	if (name === "web_fetch") return { title: "Read a page", question: fetchApprovalQuestion(props.messages) };
	return connectorLabel(name, part);
});
</script>

<template>
	<slot />
</template>
