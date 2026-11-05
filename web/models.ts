import { ref, watch } from "vue";
import type { ModelOption } from "./ai-elements";

/**
 * The models a person can pick (server/models.ts), and the one they picked last. The
 * choice is kept in this browser. A new chat starts on it; an old chat starts on the
 * model of its last reply (ChatView.vue).
 */
const KEY = "ponder-chat:model";

export const models = ref<ModelOption[]>([]);
export const model = ref(localStorage.getItem(KEY) ?? "");

watch(model, (id) => id && localStorage.setItem(KEY, id));

/** What the server can do: Python only when its sandbox is set up. */
export const features = ref({ python: false });

export async function loadModels() {
	void fetch("/api/features").then(async (response) => response.ok && (features.value = await response.json()));
	const response = await fetch("/api/models");
	if (!response.ok) return;
	const body: { models: ModelOption[]; defaultModel: string } = await response.json();
	models.value = body.models;
	// A model that left the list falls back to the default.
	if (!body.models.some((option) => option.id === model.value)) model.value = body.defaultModel;
}

export function modelName(id: unknown) {
	return models.value.find((option) => option.id === id)?.name;
}
