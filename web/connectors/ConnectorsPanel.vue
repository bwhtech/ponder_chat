<script setup lang="ts">
import { Alert, Button, Skeleton } from "frappe-ui";
import { ref } from "vue";
import PanelBody from "../settings/PanelBody.vue";
import PanelHeader from "../settings/PanelHeader.vue";
import AddConnectorDialog from "./AddConnectorDialog.vue";
import { connectors, connectorsError, loadConnectors } from "./api";
import ConnectorRow from "./ConnectorRow.vue";

/** Settings, Connectors: the MCP servers the person connected, and Add connector. */
const adding = ref(false);
const retry = () => void loadConnectors().catch(() => undefined);
</script>

<template>
	<PanelHeader title="Connectors" description="Apps that Ponder can use for you.">
		<template #actions>
			<Button variant="solid" theme="gray" icon-left="lucide-plus" label="Add connector" @click="adding = true" />
		</template>
	</PanelHeader>
	<PanelBody>
		<Alert
			v-if="!connectors && connectorsError"
			theme="red"
			title="The connectors did not load"
			:description="connectorsError"
			:primary-action="{ label: 'Retry', onClick: retry }"
		/>

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
			<p class="mt-5 flex items-start gap-2 text-p-sm text-ink-gray-5">
				<span class="lucide-shield-check mt-0.5 size-4 shrink-0" aria-hidden="true" />
				Ponder asks you before it uses a tool that changes something. You can change this for each tool on the connector's page.
			</p>
		</template>

		<div v-else class="flex flex-col items-center gap-3 py-16 text-center">
			<div class="rounded-full bg-surface-gray-2 p-3 text-ink-gray-5">
				<span class="lucide-plug size-6" aria-hidden="true" />
			</div>
			<p class="text-base text-ink-gray-7">No connectors yet</p>
			<p class="max-w-sm text-p-sm text-ink-gray-5">Connect Linear, Notion, a Frappe site or any MCP server. Then Ponder can look things up and do things there for you.</p>
			<Button variant="solid" theme="gray" icon-left="lucide-plus" label="Add connector" class="mt-2" @click="adding = true" />
		</div>
	</PanelBody>
	<AddConnectorDialog v-model:open="adding" />
</template>
