import { Selector, type SelectorProps } from "@astryxdesign/core/Selector";
import { models as modelList } from "../lib/models";
import { useStore } from "../lib/store";

/** Picks the model for this chat, from a list grouped by provider. */
export default function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
	const models = useStore(modelList);
	const providers = [...new Set(models.map((option) => option.provider ?? "Other"))];
	const toOption = (option: (typeof models)[number]) => ({ value: option.id, label: option.name, description: option.description });
	const options: SelectorProps["options"] =
		providers.length <= 1
			? models.map(toOption)
			: providers.map((provider) => ({ type: "section" as const, title: provider, options: models.filter((option) => (option.provider ?? "Other") === provider).map(toOption) }));
	return (
		<Selector
			label="Model"
			isLabelHidden
			variant="ghost"
			size="sm"
			hasSearch={!matchMedia("(pointer: coarse)").matches}
			searchPlaceholder="Find a model"
			presentation="adaptive"
			options={options}
			value={value || undefined}
			placeholder="Model"
			isLoading={!models.length}
			onChange={(next) => next && onChange(next)}
		/>
	);
}
