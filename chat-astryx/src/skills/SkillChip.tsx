import { HoverCard } from "@astryxdesign/core/HoverCard";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { useStore } from "../lib/store";
import { skills, skillTitle } from "./skills";

/**
 * A skill the person chose: in the message box (removable), and on their sent message.
 * Hovering it shows a card with what the skill does and its $name.
 */
export default function SkillChip({ name, onRemove }: { name: string; onRemove?: () => void }) {
	const title = skillTitle(name);
	// Opens only with a description: none before the skills list loads, or for a skill that is off.
	const description = useStore(skills).find((skill) => skill.name === name)?.description;
	return (
		<HoverCard content={<SkillCard name={name} title={title} description={description ?? ""} />} isEnabled={Boolean(description)} delay={300} hideDelay={100} label={title}>
			<span className="inline-flex max-w-full" data-slot="skill-chip">
				<Token label={title} color="purple" size="sm" icon={<Icon icon={SparklesIcon} />} onRemove={onRemove ? () => onRemove() : undefined} />
			</span>
		</HoverCard>
	);
}

function SkillCard({ name, title, description }: { name: string; title: string; description: string }) {
	return (
		<div className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2.5" data-slot="skill-card">
			<div className="flex items-center gap-2.5">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-purple-subtle text-purple-vivid" aria-hidden="true">
					<Icon icon={SparklesIcon} size="sm" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<Text weight="semibold" maxLines={1}>
						{title}
					</Text>
					<Text type="code" color="secondary" size="xsm" maxLines={1}>
						${name}
					</Text>
				</div>
			</div>
			<Text type="supporting" color="secondary">
				{description}
			</Text>
		</div>
	);
}
