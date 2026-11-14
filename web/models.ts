import { ref } from "vue";
import type { ModelOption } from "frappe-ui-ai-elements";
import { client } from "./api";

/**
 * The models a person can pick (server/models.ts), and the one a new chat starts on:
 * the server's default, Auto. An old chat starts on the model of its last reply
 * (ChatView.vue).
 */
export const models = ref<ModelOption[]>([]);
export const defaultModel = ref("");

/** What the server can do: Python only when its sandbox is set up. */
export const features = ref({ python: false });

export async function loadModels() {
	void loadFeatures();
	const response = await client.api.models.$get();
	if (!response.ok) return;
	const body: { models: ModelOption[]; defaultModel: string } = await response.json();
	models.value = body.models;
	defaultModel.value = body.defaultModel;
}

export function modelName(id: unknown) {
	return models.value.find((option) => option.id === id)?.name;
}

async function loadFeatures() {
	const response = await client.api.features.$get();
	if (response.ok) features.value = await response.json();
}
