import { randomInt } from "node:crypto";
import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * A workspace's slug: its address on the page (`/?w=hr-policies`). It is made from the name
 * when the workspace is made, and it never changes after, also when the workspace is renamed,
 * so a link that someone saved keeps working. A slug is never given again, also after its
 * workspace is deleted: an old link answers not found, and never opens another workspace.
 *
 * A name that another workspace's slug already has gets a short random suffix
 * ("hr-policies-k3x9"). Random, not a count: a count would tell how many others chose
 * the same name.
 */
const MAX_LENGTH = 48;
const SUFFIX_LENGTH = 4;
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const ATTEMPTS = 8;

/** Lowercase ASCII letters and digits, with single hyphens between words. */
export function slugify(name: string) {
	// "Café" is "cafe", and "Ana's" is "anas".
	const ascii = name.normalize("NFKD").replace(/[̀-ͯ'’]/g, "");
	const slug = ascii
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, MAX_LENGTH)
		.replace(/^-+|-+$/g, "");
	return slug || "workspace";
}

/** The slugs to try for a name, in order: the plain one, then with suffixes. */
export function slugCandidates(name: string, attempts = ATTEMPTS) {
	const base = slugify(name);
	return [base, ...Array.from({ length: attempts - 1 }, () => `${base}-${suffix()}`)];
}

/**
 * Gives the first free candidate to `claim`, which writes it and says whether it was free.
 * The unique index decides, so two workspaces made at once never share a slug.
 */
export function claimSlug<E>(name: string, claim: (slug: string) => Effect.Effect<boolean, E>): Effect.Effect<string, E> {
	return Effect.gen(function* () {
		for (const slug of slugCandidates(name)) {
			if (yield* claim(slug)) return slug;
		}
		return yield* Effect.die(new Error(`No free slug for “${name}” after ${ATTEMPTS} tries.`));
	});
}

/**
 * The column, its unique index, and a slug for each workspace made before slugs, oldest
 * first, so the oldest keeps the plain one. Safe to run again: it only fills empty slugs.
 */
export const migrateSlugs = Effect.fnUntraced(function* (sql: PgClient.PgClient) {
	yield* sql`alter table workspaces add column if not exists slug text`;
	yield* sql`create unique index if not exists workspaces_slug on workspaces (slug)`;
	const missing = yield* sql<{ id: string; name: string }>`select id, name from workspaces where slug is null order by created_at, id`;
	for (const row of missing) yield* claimSlug(row.name, (slug) => setSlug(sql, row.id, slug));
	yield* sql`alter table workspaces alter column slug set not null`;
});

/** Sets an empty slug when no other workspace has it; whether it did. */
function setSlug(sql: PgClient.PgClient, id: string, slug: string): Effect.Effect<boolean, SqlError> {
	return sql`
		update workspaces set slug = ${slug}
		where id = ${id} and slug is null and not exists (select 1 from workspaces where slug = ${slug})
		returning id`.pipe(Effect.map((rows) => rows.length > 0));
}

function suffix() {
	return Array.from({ length: SUFFIX_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}
