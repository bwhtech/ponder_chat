import { Button } from "@astryxdesign/core/Button";
import { features } from "../../lib/models";
import { useStore } from "../../lib/store";

/** One-click prompts on a new chat. The label is the message, so a click sends it as is. */
export default function Suggestions({ onSelect }: { onSelect: (text: string) => void }) {
	const python = useStore(features).python;
	const suggestions = [
		"Explain a concept like I'm new to it",
		"Help me write a polite follow-up email",
		python ? "Chart compound interest over 20 years" : "Plan a 3-day trip on a small budget",
	];
	return (
		<div data-slot="suggestions" className="flex w-full min-w-0 gap-2 overflow-x-auto sm:flex-wrap sm:justify-center sm:overflow-visible">
			{suggestions.map((suggestion) => (
				<Button key={suggestion} label={suggestion} variant="secondary" size="sm" className="shrink-0" data-slot="suggestion" onClick={() => onSelect(suggestion)} />
			))}
		</div>
	);
}
