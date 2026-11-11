import type { ChatComposerTrigger } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { loadSkills, skills, skillTitle, type SkillOption } from "./skills";

/**
 * The $ menu of the message box, as a trigger of Astryx's ChatComposerInput. `$` at the
 * start of a word opens it anywhere in the message; the text after it filters the list.
 * Choosing a skill takes the typed `$name` out of the text and hands the skill to
 * `onChoose`, which shows it as a chip (picker.ts).
 */
export function skillTrigger(chosen: () => string[], onChoose: (name: string) => void): ChatComposerTrigger {
	return {
		character: "$",
		menuLabel: "Skills",
		emptySearchText: "No skill matches.",
		searchSource: {
			bootstrap: () => {
				// A skill an admin turned on a moment ago shows the next time the menu opens.
				void loadSkills();
				return matches("", chosen());
			},
			search: (query) => matches(query.toLowerCase(), chosen()),
		},
		renderItem: (item) => <SkillRow skill={item.auxiliaryData as SkillOption} />,
		onSelect: (item) => {
			onChoose(item.id);
			return "";
		},
	};
}

function matches(query: string, chosen: string[]) {
	return skills
		.get()
		.filter((skill) => !chosen.includes(skill.name))
		.filter((skill) => skill.name.includes(query) || skill.description.toLowerCase().includes(query))
		.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)))
		.map((skill) => ({ id: skill.name, label: skillTitle(skill.name), auxiliaryData: skill }));
}

/** One row: the skill's title, then what it does on the same line. */
function SkillRow({ skill }: { skill: SkillOption }) {
	return (
		<span className="flex w-[min(32rem,calc(100vw-4rem))] min-w-0 items-center gap-2.5" title={skill.description} data-slot="skill-option">
			<Text weight="medium" className="shrink-0">
				{skillTitle(skill.name)}
			</Text>
			<Text color="secondary" maxLines={1} hasTruncateTooltip={false} className="min-w-0 flex-1">
				{skill.description}
			</Text>
		</span>
	);
}
