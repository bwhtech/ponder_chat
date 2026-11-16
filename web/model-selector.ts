import { ModelSelector as Selector } from "frappe-ui-ai-elements";
import { defineComponent, h, ref } from "vue";
import { modelMenuAsked } from "./models";

/**
 * The model menu in the message box, as its own chunk: it brings frappe-ui's Combobox. It
 * shows once the list of models has loaded, and loads beside that list (models.ts). Until it
 * is here, its button stands in (ModelMenuPlaceholder.vue); a tap on that one opens the menu now.
 */
export const ModelSelector = defineComponent({
	name: "ModelMenu",
	inheritAttrs: false,
	setup(_, { attrs }) {
		const open = ref(modelMenuAsked.value);
		modelMenuAsked.value = false;
		return () => h(Selector as never, { ...attrs, open: open.value, "onUpdate:open": (value: boolean) => (open.value = value) });
	},
}) as unknown as typeof Selector;
