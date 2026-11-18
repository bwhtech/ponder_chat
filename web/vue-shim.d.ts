// For the linter only (npm run lint): oxlint-tsgolint cannot read .vue files, so it sees
// each one as a component. vue-tsc reads the real ones and leaves this file out
// (web/tsconfig.vue.json).
declare module "*.vue" {
	import type { Component } from "vue";
	const component: Component;
	export default component;
}
