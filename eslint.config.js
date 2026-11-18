// ESLint only checks the TypeScript inside .vue files, which oxlint's type-aware rules
// cannot read (.oxlintrc.json). The rules are the same: no `any`, written or flowing in.
// typescript-eslint needs TypeScript 5's JS API, so run it with npm run lint:vue, which
// loads that version (scripts/typescript5.cjs) and the API's declarations it reads.
import tseslint from "typescript-eslint";
import vueParser from "vue-eslint-parser";

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
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
		},
	},
];
