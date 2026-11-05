import vue from "@vitejs/plugin-vue";
import frappeui from "frappe-ui/vite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import * as compiler from "vue/compiler-sfc";

const here = fileURLToPath(new URL(".", import.meta.url));

// frappe-ui ships .vue sources whose props import types from other files. The SFC
// compiler resolves those with the TypeScript JS API, which TypeScript 7 (this
// project's tsc) no longer has, so hand it the 5.x copy frappe-ui depends on.
const fromFrappeUI = createRequire(new URL("node_modules/frappe-ui/package.json", import.meta.url));
compiler.registerTS(() => fromFrappeUI("typescript"));

export default defineConfig({
	root: "web",
	plugins: [frappeui({ frappeProxy: false, jinjaBootData: false, buildConfig: false }), vue({ compiler })],
	css: { postcss: here },
	build: {
		outDir: "../dist",
		emptyOutDir: true,
		target: "es2022",
	},
});
