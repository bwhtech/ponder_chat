import { buildSkillFile, checkSkill, parseSkillFile } from "../shared/skill-file.ts";
import { sql } from "./db.ts";
import technicalWriting from "./standard-skills/technical-writing.ts";

/**
 * Standard skills: SKILL.md files that ship with Ponder and are on in every install.
 * Startup adds each one once. `skill_seeds` records that it was added, so a skill that an
 * admin deletes or renames does not come back on the next start. An admin's edits stay:
 * a newer file here does not overwrite the saved skill.
 */
const STANDARD_SKILLS = [technicalWriting];

export async function seedStandardSkills() {
	await sql`create table if not exists skill_seeds (name text primary key, seeded_at timestamptz not null default now())`;
	for (const source of STANDARD_SKILLS) await seed(source);
}

async function seed(source: string) {
	const skill = parseSkillFile(source);
	const errors = skill ? checkSkill(skill, true) : ["The file has no frontmatter."];
	if (!skill || errors.length) throw new Error(`Standard skill ${skill?.name ?? "?"}: ${errors.join(" ")}`);
	await sql.begin(async (tx) => {
		const [isNew] = await tx`insert into skill_seeds (name) values (${skill.name}) on conflict do nothing returning name`;
		if (!isNew) return;
		// An install that already has a skill with this name keeps its own.
		await tx`
			insert into skills (name, description, automatic, enabled, source)
			values (${skill.name}, ${skill.description}, ${skill.automatic}, true, ${buildSkillFile(skill)})
			on conflict (name) where deleted_at is null do nothing`;
	});
}
