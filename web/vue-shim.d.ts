// For the linters only (npm run lint): oxlint-tsgolint, and TypeScript without vue-tsc
// (ESLint, eslint.config.js), cannot read .vue files, so they see each one as a component.
// vue-tsc reads the real ones and leaves this file out (web/tsconfig.vue.json,
// web/browser-check/tsconfig.json).
declare module "*.vue" {
	import type { Component } from "vue";
	const component: Component;
	export default component;
}
