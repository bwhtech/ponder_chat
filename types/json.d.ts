// JSON.parse answers `unknown`, not `any`: the text comes from outside the program, so its
// value must be narrowed or decoded before use (README.md, "No `any`"). TypeScript merges
// this into its own JSON interface, and the overloads of a later declaration come first.
// Each tsconfig.json that reads JSON includes this file.
interface JSON {
	parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}
