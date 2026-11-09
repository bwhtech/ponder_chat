<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { ref } from "vue";
import PanelBody from "../settings/PanelBody.vue";
import PanelHeader from "../settings/PanelHeader.vue";
import AddConnectorDialog from "./AddConnectorDialog.vue";
import { connectors, connectorsError, loadConnectors } from "./api";
import ConnectorRow from "./ConnectorRow.vue";
import EmptyState from "../EmptyState.vue";

/** Settings, Connectors: the MCP servers the person connected, and Add connector. */
const adding = ref(false);
const retry = () => void loadConnectors().catch(() => undefined);
</script>

<template>
	<PanelHeader title="Connectors" description="Apps that Ponder can use for you.">
		<template v-if="connectors?.length && !connectorsError" #actions>
			<Button variant="solid" theme="gray" icon-left="lucide-plus" label="Add connector" @click="adding = true" />
		</template>
	</PanelHeader>
	<PanelBody>
		<EmptyState v-if="connectorsError" icon="lucide-circle-alert" title="The connectors could not load" :body="connectorsError" alert>
			<Button label="Try again" @click="retry" />
		</EmptyState>

		<div v-else-if="!connectors" class="divide-y divide-outline-gray-1" aria-busy="true" aria-label="Loading connectors">
			<div v-for="n in 3" :key="n" class="flex items-center gap-3 py-3">
				<Skeleton class="size-8 rounded-4" />
				<div class="flex-1 space-y-1.5">
					<Skeleton class="h-3.5 w-28 rounded-4" />
					<Skeleton class="h-3 w-52 rounded-4" />
				</div>
				<Skeleton class="h-5 w-9 rounded-full" />
			</div>
		</div>

		<template v-else-if="connectors.length">
			<div class="divide-y divide-outline-gray-1">
				<ConnectorRow v-for="connector in connectors" :key="connector.id" :connector="connector" />
			</div>
			<p class="mt-5 flex items-start gap-2 text-p-sm text-ink-gray-6">
				<span class="lucide-shield-check mt-0.5 size-4 shrink-0" aria-hidden="true" />
				Ponder asks you before it uses a tool that changes something. You can change this for each tool on the connector's page.
			</p>
		</template>

		<EmptyState
			v-else
			data-slot="connectors-empty"
			icon="lucide-plug"
			title="No connectors yet"
			body="Connect Linear, Notion, a Frappe site or any MCP server. Then Ponder can look things up and do things there for you."
		>
			<Button variant="solid" theme="gray" icon-left="lucide-plus" label="Add connector" @click="adding = true" />
		</EmptyState>
	</PanelBody>
	<AddConnectorDialog v-model:open="adding" />
</template>
