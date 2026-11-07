/**
 * A skill is one Markdown file: frontmatter, then the instructions. The frontmatter keys
 * are those of Agent Skills (SKILL.md), so a skill written for another tool pastes in:
 *
 *   name                      what people type after $, such as meeting-notes
 *   description               what the model reads to decide when the skill applies
 *   disable-model-invocation  true: only when a person asks for it with $name
 *
 * The server checks a file with this on save (server/skills.ts), and the admin editor
 * checks it as the admin types, so both show the same problems.
 */
export type SkillFile = {
	name: string;
	description: string;
	/** The model can load the skill on its own. False with `disable-model-invocation: true`. */
	automatic: boolean;
	/** The instructions: the file after the frontmatter. */
	body: string;
	/** What stops the file from being saved, in words for the admin. Empty when it can be saved. */
	errors: string[];
};

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
/** Every automatic skill's description goes into every reply's instructions, so it stays short. */
export const MAX_DESCRIPTION = 300;
export const MAX_FILE = 20_000;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const MANUAL_KEY = "disable-model-invocation";

export const NEW_SKILL_FILE = `---
name:
description:
---

# What this skill does

Write the steps Ponder follows, as you would brief a new colleague.
`;

export function parseSkillFile(source: string): SkillFile {
	const match = FRONTMATTER.exec(source);
	if (!match) {
		return { name: "", description: "", automatic: true, body: source.trim(), errors: ["Start the file with frontmatter between two --- lines."] };
	}
	const meta = readFrontmatter(match[1]);
	const name = meta.name ?? "";
	const description = meta.description ?? "";
	const body = match[2].trim();
	const errors: string[] = [];
	if (!name) errors.push("Add a name to the frontmatter.");
	else if (!SKILL_NAME.test(name) || name.length > MAX_NAME) {
		errors.push(`The name can have only lowercase letters, numbers and hyphens, like meeting-notes, and at most ${MAX_NAME} characters.`);
	}
	if (!description) errors.push("Add a description. Ponder reads it to decide when the skill applies.");
	else if (description.length > MAX_DESCRIPTION) errors.push(`Make the description ${MAX_DESCRIPTION} characters or fewer.`);
	if (!body) errors.push("Write the instructions under the frontmatter.");
	if (source.length > MAX_FILE) errors.push(`Make the file ${MAX_FILE.toLocaleString("en")} characters or fewer.`);
	return { name, description, automatic: meta[MANUAL_KEY] !== "true", body, errors };
}

/** Sets or removes `disable-model-invocation` in the frontmatter, so a switch and the file agree. */
export function setAutomatic(source: string, automatic: boolean): string {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
	if (!match) return source;
	const lines = match[1].split(/\r?\n/).filter((line) => !line.startsWith(`${MANUAL_KEY}:`));
	if (!automatic) lines.push(`${MANUAL_KEY}: true`);
	return `---\n${lines.join("\n")}\n---${source.slice(match[0].length)}`;
}

/** "meeting-notes" as people read it: "Meeting notes". */
export function skillTitle(name: string) {
	const words = name.replace(/-/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The flat `key: value` lines skills use. A value may be quoted, or a YAML block
 * (`>` or `|`) on the indented lines under its key, as long descriptions often are.
 */
function readFrontmatter(text: string): Record<string, string> {
	const meta: Record<string, string> = {};
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = /^([A-Za-z][\w-]*):(.*)$/.exec(lines[i]);
		if (!match) continue;
		let value = match[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const block: string[] = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
			value = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
		}
		meta[match[1]] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
	}
	return meta;
}
