/**
 * A skill: a name, a description, and Markdown instructions. Admins fill these in as
 * fields; the server keeps each skill as one Agent Skills file (SKILL.md), so it can be
 * downloaded and used elsewhere:
 *
 *   ---
 *   name: meeting-notes
 *   description: Turn a meeting transcript into decisions, owners and dates.
 *   disable-model-invocation: true
 *   ---
 *
 *   # Meeting notes
 *   ...
 *
 * `disable-model-invocation: true` means the skill runs only when a person asks for it
 * with $name. The server and the admin editor check a skill with the same rules here.
 */
export type SkillFields = {
	name: string;
	description: string;
	/** The model can load the skill on its own. False writes `disable-model-invocation: true`. */
	automatic: boolean;
	/** The instructions, in Markdown. */
	body: string;
};

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
/** Every automatic skill's description goes into every reply's instructions, so it stays short. */
export const MAX_DESCRIPTION = 300;
export const MAX_BODY = 20_000;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const MANUAL_KEY = "disable-model-invocation";

/** What stops the name and the description from being saved. Empty when they can be saved. */
export function checkDetails({ name, description }: Pick<SkillFields, "name" | "description">): string[] {
	const errors: string[] = [];
	if (!name) errors.push("Add a name.");
	else if (!SKILL_NAME.test(name) || name.length > MAX_NAME) {
		errors.push(`The name can have only lowercase letters, numbers and single hyphens, like meeting-notes, and at most ${MAX_NAME} characters.`);
	}
	if (!description.trim()) errors.push("Add a description. Ponder reads it to decide when the skill applies.");
	else if (description.length > MAX_DESCRIPTION) errors.push(`Make the description ${MAX_DESCRIPTION} characters or fewer.`);
	return errors;
}

/** What stops the whole skill from being saved. A skill that is on needs instructions. */
export function checkSkill(skill: SkillFields, enabled: boolean): string[] {
	const errors = checkDetails(skill);
	if (enabled && !skill.body.trim()) errors.push("Write the instructions before you turn the skill on.");
	if (skill.body.length > MAX_BODY) errors.push(`Make the instructions ${MAX_BODY.toLocaleString("en")} characters or fewer.`);
	return errors;
}

/** The skill as one SKILL.md file. */
export function buildSkillFile({ name, description, automatic, body }: SkillFields): string {
	const lines = ["---", `name: ${name}`, `description: ${yamlString(oneLine(description))}`];
	if (!automatic) lines.push(`${MANUAL_KEY}: true`);
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}

/**
 * Reads a SKILL.md file: the server reads its stored files with this, and the editor reads
 * a whole file pasted into the instructions. Null when the text does not start with frontmatter.
 */
export function parseSkillFile(source: string): SkillFields | null {
	const match = FRONTMATTER.exec(source);
	if (!match) return null;
	const meta = readFrontmatter(match[1]);
	return {
		name: meta.name ?? "",
		description: oneLine(meta.description ?? ""),
		automatic: meta[MANUAL_KEY] !== "true",
		body: match[2].trim(),
	};
}

/** What a typed name becomes: "Meeting Notes" is "meeting-notes". */
export function toSkillName(text: string) {
	return text
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-");
}

/** "meeting-notes" as people read it: "Meeting notes". */
export function skillTitle(name: string) {
	const words = name.replace(/-/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function oneLine(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

/** A YAML scalar: plain when that reads back the same, else double-quoted. */
function yamlString(value: string) {
	const plain = value && !/^[\s!&*?|>'"%@`#,[\]{}-]/.test(value) && !/: |\s#|:$/.test(value) && !/^(true|false|null|~|[\d.+-]+)$/i.test(value);
	return plain ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
		meta[match[1]] = unquote(value);
	}
	return meta;
}

function unquote(value: string) {
	if (/^"[\s\S]*"$/.test(value)) return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
	if (/^'[\s\S]*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
	return value;
}
