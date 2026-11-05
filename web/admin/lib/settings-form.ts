import { dialog, toast } from "frappe-ui";
import { computed, reactive, ref } from "vue";
import { api, type Admin, type KeyStatus, type Settings, type SettingsData } from "../api";
import { settings } from "../store";
import { creditValue } from "./format";

/**
 * The General settings: the credit fields with their checks and Save, the OpenRouter key's
 * status, and the admins. The settings dialog (desktop) and the Settings page (phones)
 * each make one, which loads the saved values. Reactive, so a template reads
 * `form.defaultCredits` and binds `v-model` to it.
 */
export function useSettingsForm() {
	const saved = ref<Settings | null>(null);
	const admins = ref<Admin[]>([]);
	const openRouterKey = ref<KeyStatus | null>(null);
	const defaultCredits = ref("");
	const perUsd = ref("");
	const saving = ref(false);
	const loading = ref(true);

	async function load() {
		try {
			const data = await api<SettingsData>("/settings");
			show(data);
			admins.value = data.admins;
			openRouterKey.value = data.openRouterKey;
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			loading.value = false;
		}
	}

	function show(next: Settings) {
		saved.value = { defaultDailyCredits: next.defaultDailyCredits, creditsPerUsd: next.creditsPerUsd };
		Object.assign(settings, saved.value);
		defaultCredits.value = String(next.defaultDailyCredits);
		perUsd.value = String(next.creditsPerUsd);
	}

	const wholeNumber = (value: string, min: number) => {
		const n = Number(value);
		return value.trim() !== "" && Number.isInteger(n) && n >= min;
	};
	const defaultError = computed(() => (wholeNumber(defaultCredits.value, 0) ? "" : "Enter a whole number, 0 or more."));
	const perUsdError = computed(() => (wholeNumber(perUsd.value, 1) ? "" : "Enter a whole number, 1 or more."));

	const valueChanged = computed(() => perUsd.value !== String(saved.value?.creditsPerUsd));
	const changed = computed(() => defaultCredits.value !== String(saved.value?.defaultDailyCredits) || valueChanged.value);
	const canSave = computed(() => Boolean(saved.value) && changed.value && !defaultError.value && !perUsdError.value);

	async function apply() {
		saving.value = true;
		try {
			const body = { defaultDailyCredits: Number(defaultCredits.value), creditsPerUsd: Number(perUsd.value) };
			show(await api<Settings>("/settings", { method: "PUT", body }));
			toast.success("Settings saved");
		} finally {
			saving.value = false;
		}
	}

	function save() {
		if (!canSave.value || !saved.value) return;
		if (!valueChanged.value) return void apply().catch((e: Error) => toast.error(e.message));
		// A new credit value changes what every limit is worth, today's use included.
		const before = creditValue(saved.value.creditsPerUsd);
		const after = creditValue(Number(perUsd.value));
		const budget = (Number(defaultCredits.value) / Number(perUsd.value)).toFixed(2);
		dialog.confirm({
			title: "Change what a credit is worth?",
			message: `One credit goes from ${before} to ${after}. Limits keep their numbers, so a default of ${defaultCredits.value} credits becomes $${budget} a day. Today's use is counted again at the new value.`,
			confirmLabel: "Change it",
			onConfirm: apply,
		});
	}

	void load();
	return reactive({ saved, admins, openRouterKey, defaultCredits, perUsd, saving, loading, defaultError, perUsdError, canSave, save });
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
