import { tool, type DataUIPart, type TextPart, type ToolSet, type UIDataTypes } from "ai";
import { z } from "zod";
import { SKILL_NAME } from "../../shared/skill-file.ts";
import type { ActiveSkill } from "../skills.ts";

/**
 * Skills in a reply (server/skills.ts). Two ways in:
 *
 * - Automatic skills are listed in the instructions by name and description. The model
 *   loads one with use_skill when it fits, so a skill costs one line until it is used.
 * - A person starts any skill that is on with $name. The message then carries a
 *   `data-skill` part, and the skill's instructions go into that message
 *   (skillPartText), on this turn and on every later one, so a follow-up still has them.
 *
 * The step's result is recorded, so a replayed run uses the skills it started with,
 * even if an admin changed one in the meantime.
 */
export const USE_SKILL = "use_skill";
export const SKILL_PART = "data-skill";

/** The section for the instructions. Empty with no skills on. */
export function skillsGuidance(skills: ActiveSkill[]): string {
	if (!skills.length) return "";
	const automatic = skills.filter((skill) => skill.automatic);
	const chosen = `When the person's message holds a <skill> block, they chose that skill for the message: follow its instructions. It is loaded already.`;
	if (!automatic.length) return `Skills are instructions that your admins wrote for kinds of tasks. ${chosen}`;
	return `Skills are instructions that your admins wrote for kinds of tasks. ${chosen}

Before you start a task that one of these skills covers, load it with ${USE_SKILL}, then follow it. Load only a skill that fits; most messages need none.
${automatic.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`;
}

/** use_skill, when at least one automatic skill is on. It reads the recorded skills, so it needs no step of its own. */
export function skillTools(skills: ActiveSkill[]): ToolSet {
	const automatic = skills.filter((skill) => skill.automatic);
	if (!automatic.length) return {};
	const names = automatic.map((skill) => skill.name) as [string, ...string[]];
	return {
		[USE_SKILL]: tool({
			description: "Load a skill listed in your instructions: the full instructions an admin wrote for that kind of task. Load it before you start the task, then follow it.",
			inputSchema: z.object({ name: z.enum(names).describe("The skill to load.") }),
			execute: async ({ name }) => automatic.find((skill) => skill.name === name)?.body ?? `No skill is named ${name}.`,
		}),
	};
}

/** A skill the person chose ($name) as text in their message, for convertToModelMessages. */
export function skillPartText(part: DataUIPart<UIDataTypes>, skills: ActiveSkill[]): TextPart | undefined {
	if (part.type !== SKILL_PART) return undefined;
	const name = (part.data as { name?: unknown } | undefined)?.name;
	// The browser wrote the part, so a name that is not a skill name never reaches the prompt.
	if (typeof name !== "string" || !SKILL_NAME.test(name)) return undefined;
	const skill = skills.find((each) => each.name === name);
	const text = skill
		? `<skill name="${name}">\nThe person chose this skill for this message. Follow its instructions.\n\n${skill.body}\n</skill>`
		: `<skill name="${name}">\nThe person chose this skill, but an admin turned it off or deleted it. Say so briefly, then answer as well as you can without it.\n</skill>`;
	return { type: "text", text };
}
