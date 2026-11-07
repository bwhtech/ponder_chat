import { parseSkillFile, type SkillFile } from "../shared/skill-file.ts";
import { displayName } from "./admin/people.ts";
import { sql } from "./db.ts";

/**
 * Skills: Markdown files of instructions that admins write on /admin. A skill that is on
 * works for everyone. An automatic skill is listed in every reply's instructions, and the
 * model loads it with use_skill when its description fits (workflow/skills.ts). Any skill
 * that is on can be started by a person with $name in the message box.
 *
 * The file is the source of truth. The name, the description and `automatic` are read
 * from it on save and kept in their own columns, for the list and the menu.
 *
 * A deleted skill keeps its row, with `deleted_at`. Its name is free again for a new skill.
 */
export type SkillSummary = {
	id: number;
	name: string;
	description: string;
	automatic: boolean;
	enabled: boolean;
	updatedAt: string;
	updatedBy: string | null;
};

export type SkillDetail = SkillSummary & { source: string };

/** What a reply needs of an enabled skill. */
export type ActiveSkill = { name: string; description: string; automatic: boolean; body: string };

type Row = {
	id: string;
	name: string;
	description: string;
	automatic: boolean;
	enabled: boolean;
	source: string;
	updated_at: Date;
	updated_by_name: string | null;
	updated_by_email: string | null;
};

const CACHE_MS = 5_000;
let cached: { skills: ActiveSkill[]; at: number } | undefined;

export async function migrateSkills() {
	await sql`
		create table if not exists skills (
			id bigserial primary key,
			name text not null,
			description text not null,
			automatic boolean not null default true,
			enabled boolean not null default true,
			source text not null,
			created_by text,
			created_at timestamptz not null default now(),
			updated_by text,
			updated_at timestamptz not null default now(),
			deleted_at timestamptz
		)`;
	await sql`create unique index if not exists skills_live_name on skills (name) where deleted_at is null`;
}

export async function listSkills(): Promise<SkillSummary[]> {
	const rows = await sql<Row[]>`
		select s.*, u.name as updated_by_name, u.email as updated_by_email from skills s left join users u on u.id = s.updated_by
		where s.deleted_at is null order by s.name`;
	return rows.map(summary);
}

export async function getSkill(id: number): Promise<SkillDetail | undefined> {
	const [row] = await sql<Row[]>`
		select s.*, u.name as updated_by_name, u.email as updated_by_email from skills s left join users u on u.id = s.updated_by
		where s.id = ${id} and s.deleted_at is null`;
	return row && { ...summary(row), source: row.source };
}

export type SaveResult = { ok: true; skill: SkillDetail } | { ok: false; status: 400 | 404 | 409; error: string; errors?: string[] };

/**
 * Creates a skill (no id) or saves one. `expectedUpdatedAt` is when the admin's copy was
 * loaded: when someone else saved the skill since, the save is refused, so it does not
 * overwrite their change.
 */
export async function saveSkill(
	input: { id?: number; source: string; enabled: boolean; expectedUpdatedAt?: string },
	by: string,
): Promise<SaveResult> {
	const file = parseSkillFile(input.source);
	if (file.errors.length) return { ok: false, status: 400, error: "Fix the problems in the file first.", errors: file.errors };
	try {
		const id = input.id === undefined ? await insert(file, input, by) : await update(input.id, file, input, by);
		if (id === "missing") return { ok: false, status: 404, error: "This skill was deleted." };
		if (id === "stale") return { ok: false, status: 409, error: "Someone else saved this skill after you opened it. Reload to see their change." };
		cached = undefined;
		return { ok: true, skill: (await getSkill(id))! };
	} catch (error) {
		if ((error as { code?: string }).code === "23505") return { ok: false, status: 409, error: `Another skill is named ${file.name}.` };
		throw error;
	}
}

async function insert(file: SkillFile, input: { source: string; enabled: boolean }, by: string) {
	const [row] = await sql<{ id: string }[]>`
		insert into skills (name, description, automatic, enabled, source, created_by, updated_by)
		values (${file.name}, ${file.description}, ${file.automatic}, ${input.enabled}, ${input.source}, ${by}, ${by})
		returning id`;
	return Number(row.id);
}

async function update(id: number, file: SkillFile, input: { source: string; enabled: boolean; expectedUpdatedAt?: string }, by: string) {
	const [row] = await sql<{ id: string }[]>`
		update skills set name = ${file.name}, description = ${file.description}, automatic = ${file.automatic},
			enabled = ${input.enabled}, source = ${input.source}, updated_by = ${by}, updated_at = now()
		where id = ${id} and deleted_at is null
			and (${input.expectedUpdatedAt ?? null}::timestamptz is null or date_trunc('milliseconds', updated_at) = ${input.expectedUpdatedAt ?? null}::timestamptz)
		returning id`;
	if (row) return id;
	const [exists] = await sql`select 1 from skills where id = ${id} and deleted_at is null`;
	return exists ? ("stale" as const) : ("missing" as const);
}

/** On or off for everyone. False when there is no such skill. */
export async function setSkillEnabled(id: number, enabled: boolean, by: string) {
	const rows = await sql`
		update skills set enabled = ${enabled}, updated_by = ${by}, updated_at = now()
		where id = ${id} and deleted_at is null returning id`;
	cached = undefined;
	return rows.length > 0;
}

export async function deleteSkill(id: number, by: string) {
	const rows = await sql`
		update skills set deleted_at = now(), updated_by = ${by}, updated_at = now()
		where id = ${id} and deleted_at is null returning id`;
	cached = undefined;
	return rows.length > 0;
}

/** The skills that are on, for a reply and for the $ menu. Kept for a few seconds; a change on /admin shows at once in this process. */
export async function activeSkills(): Promise<ActiveSkill[]> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.skills;
	const rows = await sql<Pick<Row, "name" | "description" | "automatic" | "source">[]>`
		select name, description, automatic, source from skills where enabled and deleted_at is null order by name`;
	const skills = rows.map((row) => ({ name: row.name, description: row.description, automatic: row.automatic, body: parseSkillFile(row.source).body }));
	cached = { skills, at: Date.now() };
	return skills;
}

function summary(row: Row): SkillSummary {
	return {
		id: Number(row.id),
		name: row.name,
		description: row.description,
		automatic: row.automatic,
		enabled: row.enabled,
		updatedAt: row.updated_at.toISOString(),
		updatedBy: row.updated_by_email ? displayName(row.updated_by_name, row.updated_by_email) : null,
	};
}
