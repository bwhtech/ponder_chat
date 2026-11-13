import { dialog, toast } from "frappe-ui";
import { computed, reactive, ref } from "vue";
import { admin, unwrap, type Admin, type KeyStatus, type Settings } from "../api";
import { settings } from "../store";
import { creditValue, money } from "./format";

/**
 * The General settings: the credit fields with their checks and Save, how PDFs are read
 * and the summary model (each saved as soon as it changes), the OpenRouter key's status, and the admins. The settings dialog (desktop) and the Settings page (phones)
 * each make one, which loads the saved values. Reactive, so a template reads
 * `form.defaultCredits` and binds `v-model` to it.
 */
export function useSettingsForm() {
	const saved = ref<Settings | null>(null);
	const admins = ref<Admin[]>([]);
	const openRouterKey = ref<KeyStatus | null>(null);
	const defaultCredits = ref("");
	const perUsd = ref("");
	const pdfTextOnServer = ref(true);
	const savingPdf = ref(false);
	const compactionModel = ref("");
	const savingModel = ref(false);
	const models = ref<{ label: string; value: string }[]>([]);
	const saving = ref(false);
	/** Until the saved values load, no control shows: a default there would read as the setting. */
	const status = ref<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
	const loading = computed(() => status.value.kind !== "loaded");
	const loadError = computed(() => (status.value.kind === "error" ? status.value.message : ""));

	async function load() {
		status.value = { kind: "loading" };
		try {
			const data = await unwrap(admin.settings.$get());
			show(data);
			admins.value = data.admins;
			openRouterKey.value = data.openRouterKey;
			models.value = data.models.map((model) => ({ label: model.name, value: model.id }));
			status.value = { kind: "loaded" };
		} catch (e) {
			status.value = { kind: "error", message: (e as Error).message };
		}
	}

	function show(next: Settings) {
		saved.value = {
			defaultDailyCredits: next.defaultDailyCredits,
			creditsPerUsd: next.creditsPerUsd,
			pdfTextOnServer: next.pdfTextOnServer,
			compactionModel: next.compactionModel,
		};
		Object.assign(settings, saved.value);
		pdfTextOnServer.value = next.pdfTextOnServer;
		compactionModel.value = next.compactionModel;
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
			show(await unwrap(admin.settings.$put({ json: body })));
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
		const budget = money(Number(defaultCredits.value) / Number(perUsd.value));
		dialog.confirm({
			title: "Change what a credit is worth?",
			message: `One credit goes from ${before} to ${after}. Limits keep their numbers, so a default of ${defaultCredits.value} credits becomes ${budget} a day. Today's use is counted again at the new value.`,
			confirmLabel: "Change it",
			onConfirm: apply,
		});
	}

	/** The switch saves at once; a failure puts it back. */
	async function setPdfReading(onServer: boolean) {
		if (!saved.value) return;
		pdfTextOnServer.value = onServer;
		savingPdf.value = true;
		try {
			const next = await unwrap(admin.settings["pdf-reading"].$put({ json: { onServer } }));
			if (saved.value) saved.value.pdfTextOnServer = next.pdfTextOnServer;
			settings.pdfTextOnServer = next.pdfTextOnServer;
			pdfTextOnServer.value = next.pdfTextOnServer;
			toast.success(onServer ? "PDFs are read on this server" : "PDFs go to the model");
		} catch (e) {
			pdfTextOnServer.value = !onServer;
			toast.error((e as Error).message);
		} finally {
			savingPdf.value = false;
		}
	}

	/** The select saves at once; a failure puts it back. */
	async function setCompactionModel(model: string) {
		if (!saved.value || !model || model === saved.value.compactionModel) return;
		const before = saved.value.compactionModel;
		compactionModel.value = model;
		savingModel.value = true;
		try {
			const next = await unwrap(admin.settings["compaction-model"].$put({ json: { model } }));
			if (saved.value) saved.value.compactionModel = next.compactionModel;
			settings.compactionModel = next.compactionModel;
			compactionModel.value = next.compactionModel;
			toast.success("Summary model saved");
		} catch (e) {
			compactionModel.value = before;
			toast.error((e as Error).message);
		} finally {
			savingModel.value = false;
		}
	}

	void load();
	return reactive({
		saved,
		admins,
		openRouterKey,
		defaultCredits,
		perUsd,
		pdfTextOnServer,
		savingPdf,
		compactionModel,
		savingModel,
		models,
		saving,
		loading,
		loadError,
		load,
		defaultError,
		perUsdError,
		canSave,
		save,
		setPdfReading,
		setCompactionModel,
	});
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
