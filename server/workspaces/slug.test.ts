import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { claimSlug, slugCandidates, slugify } from "./slug.ts";

/** A workspace's slug from its name (slug.ts). Collisions and the backfill run on Postgres in Workspaces.test.ts. */
describe("slugify", () => {
	it("makes lowercase ASCII words with single hyphens", () => {
		const cases: [string, string][] = [
			["HR policies", "hr-policies"],
			["  Dialysis unit  ", "dialysis-unit"],
			["Ana's notes", "anas-notes"],
			["Café & Crème Brûlée", "cafe-creme-brulee"],
			["Q3 / 2026 — plans!", "q3-2026-plans"],
			["---", "workspace"],
			["日本語", "workspace"],
		];
		for (const [name, slug] of cases) assert.strictEqual(slugify(name), slug, name);
	});

	it("keeps a long name to 48 characters, without a hyphen at the end", () => {
		const slug = slugify(`${"a".repeat(47)} b c`);
		assert.isAtMost(slug.length, 48);
		assert.notMatch(slug, /-$/);
	});
});

describe("claimSlug", () => {
	it("tries the plain slug first, then the same with a short random suffix", () => {
		const [first, ...others] = slugCandidates("HR policies");
		assert.strictEqual(first, "hr-policies");
		for (const other of others) assert.match(other, /^hr-policies-[a-z2-9]{4}$/);
	});

	it.effect("takes the first slug that is free", () =>
		Effect.gen(function* () {
			const taken = new Set(["hr-policies"]);
			const tried: string[] = [];
			const slug = yield* claimSlug("HR policies", (candidate) => Effect.sync(() => (tried.push(candidate), !taken.has(candidate))));
			assert.match(slug, /^hr-policies-[a-z2-9]{4}$/);
			assert.deepStrictEqual(tried, ["hr-policies", slug]);
		}),
	);
});
