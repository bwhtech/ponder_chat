import { defineAsyncComponent, ref } from "vue";
import type { ModelOption } from "frappe-ui-ai-elements";
import { client } from "./api";
import { fromBoot } from "./boot";
import { once } from "./once";

/**
 * The models a person can pick (server/models.ts), and the one a new chat starts on:
 * the server's default, Auto. An old chat starts on the model of its last reply
 * (ChatView.vue).
 */
export const models = ref<ModelOption[]>([]);
export const defaultModel = ref("");

/** What the server can do: Python only when its sandbox is set up. */
export const features = ref({ python: false });

/** The model menu (model-selector.ts). It shows once the models are here, and loads beside them. */
const loadModelSelector = once(() => import("./model-selector").then((module) => module.ModelSelector));
export const ModelSelector = defineAsyncComponent(loadModelSelector);

/** The first time, the page brings both lists (boot.ts); the server leaves out the models only just after a start. */
export async function loadModels() {
	void loadFeatures();
	void loadModelSelector().catch(() => undefined);
	const body: { models: ModelOption[]; defaultModel: string } | undefined = fromBoot("models") ?? (await fetchModels());
	if (!body) return;
	models.value = body.models;
	defaultModel.value = body.defaultModel;
}

async function fetchModels() {
	const response = await client.api.models.$get();
	return response.ok ? response.json() : undefined;
}

export function modelName(id: unknown) {
	return models.value.find((option) => option.id === id)?.name;
}

async function loadFeatures() {
	const booted = fromBoot("features");
	if (booted) return void (features.value = booted);
	const response = await client.api.features.$get();
	if (response.ok) features.value = await response.json();
}
