import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import { buildSkillFile, checkSkill, parseSkillFile } from "../shared/skill-file.ts";
import docx from "./standard-skills/docx.ts";
import technicalWriting from "./standard-skills/technical-writing.ts";

/**
 * Standard skills: SKILL.md files that ship with Ponder and are on in every install.
 * Startup adds each one once. `skill_seeds` records that it was added, so a skill that an
 * admin deletes or renames does not come back on the next start. An admin's edits stay:
 * a newer file here does not overwrite the saved skill.
 */
const STANDARD_SKILLS = [technicalWriting, docx];

/** After the skills table (Skills.migrate). A standard skill that does not pass the checks is a bug in this file: a defect. */
export const seedStandardSkills = Effect.fn("StandardSkills.seed")(function* () {
	const sql = yield* PgClient.PgClient;
	yield* sql`create table if not exists skill_seeds (name text primary key, seeded_at timestamptz not null default now())`;
	for (const source of STANDARD_SKILLS) {
		const skill = parseSkillFile(source);
		const errors = skill ? checkSkill(skill, true) : ["The file has no frontmatter."];
		if (!skill || errors.length) return yield* Effect.die(new Error(`Standard skill ${skill?.name ?? "?"}: ${errors.join(" ")}`));
		yield* sql.withTransaction(
			Effect.gen(function* () {
				const isNew = yield* sql`insert into skill_seeds (name) values (${skill.name}) on conflict do nothing returning name`;
				if (!isNew.length) return;
				// An install that already has a skill with this name keeps its own.
				yield* sql`
					insert into skills (name, description, automatic, enabled, source)
					values (${skill.name}, ${skill.description}, ${skill.automatic}, true, ${buildSkillFile(skill)})
					on conflict (name) where deleted_at is null do nothing`;
			}),
		);
	}
});
