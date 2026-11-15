import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { buildSkillFile, checkSkill, parseSkillFile, type SkillFields } from "../shared/skill-file.ts";
import { displayName } from "./admin/people.ts";
import { pgCode } from "./runtime/Database.ts";

/**
 * Skills: Markdown files of instructions that admins write on /admin. A skill that is on
 * works for everyone. An automatic skill is listed in every reply's instructions, and the
 * model loads it with use_skill when its description fits (workflow/skills.ts). Any skill
 * that is on can be started by a person with $name in the message box.
 *
 * Admins fill in the name, the description and the instructions as fields. The server
 * writes them as one Agent Skills file (SKILL.md) in `source`, which can be downloaded,
 * and keeps the name, the description and `automatic` in their own columns as well, for
 * the list and the menu.
 *
 * A deleted skill keeps its row, with `deleted_at`. Its name is free again for a new skill.
 */
export type SkillSummary = {
	id: number;
	name: string;
	description: string;
	/** Ponder can load it on its own. False: only when someone types $name. */
	automatic: boolean;
	enabled: boolean;
	updatedAt: string;
	updatedBy: string | null;
};

/** `body` is the instructions; `source` the whole file, for a download. */
export type SkillDetail = SkillSummary & { body: string; source: string };

/** What a reply needs of an enabled skill. */
export type ActiveSkill = { name: string; description: string; automatic: boolean; body: string };

export type SaveResult = { ok: true; skill: SkillDetail } | { ok: false; status: 400 | 404 | 409; error: string; errors?: string[] };

export type SkillInput = SkillFields & { id?: number; enabled: boolean; expectedUpdatedAt?: string };

const CACHE_MS = 5_000;

// `id` is a bigserial, which the client reads as a bigint.
const Row = Schema.Struct({
	id: Schema.BigInt,
	name: Schema.String,
	description: Schema.String,
	automatic: Schema.Boolean,
	enabled: Schema.Boolean,
	source: Schema.String,
	updated_at: Schema.Date,
	updated_by_name: Schema.NullOr(Schema.String),
	updated_by_email: Schema.NullOr(Schema.String),
});
type Row = typeof Row.Type;
const ActiveRow = Schema.Struct({ name: Schema.String, description: Schema.String, automatic: Schema.Boolean, source: Schema.String });
const IdRow = Schema.Struct({ id: Schema.BigInt });
const SourceRow = Schema.Struct({ source: Schema.String });

export class Skills extends Context.Service<
	Skills,
	{
		readonly migrate: Effect.Effect<void, SqlError>;
		readonly list: Effect.Effect<SkillSummary[], SqlError>;
		/** A skill that is not deleted, or none. */
		readonly get: (id: number) => Effect.Effect<Option.Option<SkillDetail>, SqlError>;
		/**
		 * Creates a skill (no id) or saves one. A new skill can start without instructions, off;
		 * a skill that is on needs them. `expectedUpdatedAt` is when the admin's copy was loaded:
		 * when someone else saved the skill since, the save is refused, so it does not overwrite
		 * their change. A refusal is the answer for the admin, not a failure.
		 */
		readonly save: (input: SkillInput, by: string) => Effect.Effect<SaveResult, SqlError>;
		/** On or off for everyone. A skill with no instructions can't be turned on. */
		readonly setEnabled: (id: number, enabled: boolean, by: string) => Effect.Effect<"ok" | "missing" | "empty", SqlError>;
		/** False when there is no such skill. */
		readonly remove: (id: number, by: string) => Effect.Effect<boolean, SqlError>;
		/** The skills that are on, for a reply and for the $ menu. Kept for a few seconds; a change on /admin shows at once. */
		readonly active: Effect.Effect<ActiveSkill[], SqlError>;
	}
>()("ponder/skills/Skills") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const cached = yield* Ref.make(Option.none<{ skills: ActiveSkill[]; at: number }>());
	const forget = Ref.set(cached, Option.none());

	const migrate = Effect.gen(function* () {
		yield* sql`
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
		yield* sql`create unique index if not exists skills_live_name on skills (name) where deleted_at is null`;
	});

	const findAll = SqlSchema.findAll({
		Request: Schema.Void,
		Result: Row,
		execute: () => sql`
			select s.*, u.name as updated_by_name, u.email as updated_by_email from skills s left join users u on u.id = s.updated_by
			where s.deleted_at is null order by s.name`,
	});
	const findOne = SqlSchema.findOneOption({
		Request: Schema.Number,
		Result: Row,
		execute: (id) => sql`
			select s.*, u.name as updated_by_name, u.email as updated_by_email from skills s left join users u on u.id = s.updated_by
			where s.id = ${id} and s.deleted_at is null`,
	});
	const findActive = SqlSchema.findAll({
		Request: Schema.Void,
		Result: ActiveRow,
		execute: () => sql`select name, description, automatic, source from skills where enabled and deleted_at is null order by name`,
	});
	const findSource = SqlSchema.findOneOption({
		Request: Schema.Number,
		Result: SourceRow,
		execute: (id) => sql`select source from skills where id = ${id} and deleted_at is null`,
	});

	// A row that does not decode is not Ponder's: a defect.
	const list = findAll(undefined).pipe(
		Effect.map((rows) => rows.map(summary)),
		Effect.catchTags({ SchemaError: Effect.die }),
		Effect.withSpan("Skills.list"),
	);

	const get = Effect.fn("Skills.get")(function* (id: number) {
		const row = yield* findOne(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found): SkillDetail => ({ ...summary(found), body: bodyOf(found.source), source: found.source }));
	});

	type Saving = SkillInput & { source: string };

	const insert = Effect.fnUntraced(function* (file: Saving, by: string) {
		const rows = yield* sql`
			insert into skills (name, description, automatic, enabled, source, created_by, updated_by)
			values (${file.name}, ${file.description}, ${file.automatic}, ${file.enabled}, ${file.source}, ${by}, ${by})
			returning id`;
		return Number(Schema.decodeUnknownSync(IdRow)(rows[0]).id);
	});

	const update = Effect.fnUntraced(function* (id: number, file: Saving, by: string) {
		const expected = file.expectedUpdatedAt ?? null;
		const rows = yield* sql`
			update skills set name = ${file.name}, description = ${file.description}, automatic = ${file.automatic},
				enabled = ${file.enabled}, source = ${file.source}, updated_by = ${by}, updated_at = now()
			where id = ${id} and deleted_at is null
				and (${expected}::timestamptz is null or date_trunc('milliseconds', updated_at) = ${expected}::timestamptz)
			returning id`;
		if (rows.length) return id;
		const exists = yield* sql`select 1 from skills where id = ${id} and deleted_at is null`;
		return exists.length ? ("stale" as const) : ("missing" as const);
	});

	const save = Effect.fn("Skills.save")(function* (input: SkillInput, by: string) {
		const errors = checkSkill(input, input.enabled);
		if (errors.length) return { ok: false, status: 400, error: errors.length === 1 ? errors[0] : "Fix the problems first.", errors } satisfies SaveResult;
		const file = { ...input, source: buildSkillFile(input) };
		const saved = yield* (input.id === undefined ? insert(file, by) : update(input.id, file, by)).pipe(
			Effect.catchTags({ SqlError: (error) => (pgCode(error) === "23505" ? Effect.succeed("taken" as const) : Effect.fail(error)) }),
		);
		if (saved === "taken") return { ok: false, status: 409, error: `Another skill is named ${file.name}.` } satisfies SaveResult;
		if (saved === "missing") return { ok: false, status: 404, error: "This skill was deleted." } satisfies SaveResult;
		if (saved === "stale") return { ok: false, status: 409, error: "Someone else saved this skill after you opened it. Reload to see their change." } satisfies SaveResult;
		yield* forget;
		// Saved just now, in this call: it is there.
		const skill = yield* get(saved).pipe(Effect.flatMap(Effect.fromOption), Effect.catchTags({ NoSuchElementError: Effect.die }));
		return { ok: true, skill } satisfies SaveResult;
	});

	const setEnabled = Effect.fn("Skills.setEnabled")(function* (id: number, enabled: boolean, by: string) {
		const row = yield* findSource(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (Option.isNone(row)) return "missing" as const;
		if (enabled && !bodyOf(row.value.source)) return "empty" as const;
		yield* sql`update skills set enabled = ${enabled}, updated_by = ${by}, updated_at = now() where id = ${id} and deleted_at is null`;
		yield* forget;
		return "ok" as const;
	});

	const remove = Effect.fn("Skills.remove")(function* (id: number, by: string) {
		const rows = yield* sql`
			update skills set deleted_at = now(), updated_by = ${by}, updated_at = now()
			where id = ${id} and deleted_at is null returning id`;
		yield* forget;
		return rows.length > 0;
	});

	// No span of its own: every reply and every $ menu reads it, nearly always from the cache.
	const active = Effect.gen(function* () {
		const known = yield* Ref.get(cached);
		if (Option.isSome(known) && (yield* Clock.currentTimeMillis) - known.value.at < CACHE_MS) return known.value.skills;
		const rows = yield* findActive(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		const skills = rows.map((row): ActiveSkill => ({ name: row.name, description: row.description, automatic: row.automatic, body: bodyOf(row.source) }));
		yield* Ref.set(cached, Option.some({ skills, at: yield* Clock.currentTimeMillis }));
		return skills;
	});

	return Skills.of({ migrate, list, get, save, setEnabled, remove, active });
});

export const layer = Layer.effect(Skills, make);

function bodyOf(source: string) {
	return parseSkillFile(source)?.body ?? source.trim();
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
