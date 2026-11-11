import { ChatToolCalls } from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { callStatus, phaseError, toolPhase } from "../chat/parts/tool-state";
import type { ToolRendererProps } from "../chat/tool-renderers";
import { useStore } from "../lib/store";
import { skills, skillTitle } from "./skills";

/** A use_skill call (server/workflow/skills.ts): Ponder chose a skill on its own. One line, with what the skill is for below. */
export default function UseSkillPart({ part, streaming }: ToolRendererProps) {
	const name = String(((part as { input?: unknown }).input as { name?: string } | undefined)?.name ?? "");
	const description = useStore(skills).find((skill) => skill.name === name)?.description;
	const phase = toolPhase(part, { streaming });
	// A skill's name in curly quotes, as Memory quotes chat titles.
	const target = name ? `“${skillTitle(name)}”` : "a skill";
	const verb = phase === "preparing" || phase === "running" ? "Loading skill" : phase === "failed" || phase === "stopped" ? "Could not load skill" : "Picked skill";
	return (
		<ChatToolCalls
			data-slot="use-skill"
			calls={[
				{
					key: part.toolCallId,
					name: verb,
					target,
					status: callStatus(phase),
					errorMessage: phaseError(part, phase),
					resultDetail: (
						<Text type="supporting" color="secondary">
							Ponder chose this skill for the question.{description ? ` ${description}` : ""}
						</Text>
					),
				},
			]}
		/>
	);
}
