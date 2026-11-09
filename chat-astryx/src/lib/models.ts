import { createStore } from "./store";

/**
 * The models a person can pick (server/models.ts), and the one they picked last. The
 * choice is kept in this browser. A new chat starts on it; an old chat starts on the
 * model of its last reply (ChatView).
 */
export type ModelOption = { id: string; name: string; provider?: string; description?: string };

const KEY = "ponder-chat:model";

export const models = createStore<ModelOption[]>([]);
export const model = createStore<string>(localStorage.getItem(KEY) ?? "");
model.subscribe(() => {
	const id = model.get();
	if (id) localStorage.setItem(KEY, id);
});

/** What the server can do: Python only when its sandbox is set up. */
export const features = createStore({ python: false });

export async function loadModels() {
	void fetch("/api/features").then(async (response) => response.ok && features.set(await response.json()));
	const response = await fetch("/api/models");
	if (!response.ok) return;
	const body: { models: ModelOption[]; defaultModel: string } = await response.json();
	models.set(body.models);
	// A model that left the list falls back to the default.
	if (!body.models.some((option) => option.id === model.get())) model.set(body.defaultModel);
}

export function modelName(id: unknown) {
	return models.get().find((option) => option.id === id)?.name;
}
