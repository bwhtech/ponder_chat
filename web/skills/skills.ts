import type { UIMessage } from "ai";
import { ref } from "vue";

export { skillTitle } from "../../shared/skill-file";

/**
 * The skills that are on (server/skills.ts), for the $ menu in the message box. Loaded when
 * a chat opens, and again each time the menu opens, so a skill an admin just turned on shows.
 */
export type SkillOption = { name: string; description: string };

/** A user message's part for a skill the person chose with $name (server/workflow/skills.ts). */
export const SKILL_PART = "data-skill";
export type SkillPart = { type: typeof SKILL_PART; data: { name: string } };

export const skills = ref<SkillOption[]>([]);
/** The list came from the server: a skill not in it is off, or was deleted. */
export const skillsLoaded = ref(false);

export async function loadSkills() {
	const response = await fetch("/api/skills").catch(() => undefined);
	if (!response?.ok) return;
	skills.value = (await response.json()).skills;
	skillsLoaded.value = true;
}

export function skillDescription(name: string) {
	return skills.value.find((skill) => skill.name === name)?.description;
}

/** The skills the person chose in a message. */
export function chosenSkills(message: UIMessage | undefined): string[] {
	if (message?.role !== "user") return [];
	return message.parts.flatMap((part) => (part.type === SKILL_PART ? [String((part as SkillPart).data?.name ?? "")] : [])).filter(Boolean);
}

export const skillPart = (name: string): SkillPart => ({ type: SKILL_PART, data: { name } });
