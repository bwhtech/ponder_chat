// ESLint only checks the TypeScript inside .vue files, which oxlint's type-aware rules
// cannot read (.oxlintrc.json). The rules are the same: no `any`, written or flowing in,
// and no type assertion from `any` (scripts/no-any-casts.ts).
// typescript-eslint needs TypeScript 5's JS API, so run it with npm run lint:vue, which
// loads that version (scripts/typescript5.cjs) and the API's declarations it reads.
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

/**
 * typescript-eslint's no-unsafe-type-assertion, without the reports of an assertion that
 * narrows a type that is not `any`: as scripts/no-any-casts.ts does for the .ts files.
 * Every other report stays, so a new kind of report fails until it is listed here.
 */
const NARROWING = new Set(["unsafeTypeAssertion", "unsafeTypeAssertionAssignableToConstraint", "unsafeToUnconstrainedTypeAssertion"]);
const unsafeTypeAssertion = tseslint.plugin.rules["no-unsafe-type-assertion"];
const noAnyCast = {
	meta: unsafeTypeAssertion.meta,
	create(context) {
		const report = (descriptor) => {
			if (!NARROWING.has(descriptor.messageId)) context.report(descriptor);
		};
		return unsafeTypeAssertion.create(Object.create(context, { report: { value: report } }));
	},
};

export default [
	{
		files: ["web/**/*.vue"],
		// Comments cannot turn the rules off (README.md, "No `any`").
		linterOptions: { noInlineConfig: true },
		languageOptions: {
			parser: vueParser,
			parserOptions: {
				parser: tseslint.parser,
				// The browser-only program: the API's types come from their declarations, not
				// the server's code, which makes this run ten times faster.
				project: "./web/browser-check/tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".vue"],
				sourceType: "module",
			},
		},
		plugins: { "@typescript-eslint": tseslint.plugin, ponder: { rules: { "no-any-cast": noAnyCast } } },
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"ponder/no-any-cast": "error",
		},
	},
];
