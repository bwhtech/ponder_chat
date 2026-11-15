import vue from "@vitejs/plugin-vue";
import frappeui from "frappe-ui/vite";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import * as compiler from "vue/compiler-sfc";

const here = fileURLToPath(new URL(".", import.meta.url));

// frappe-ui ships .vue sources whose props import types from other files. The SFC
// compiler resolves those with the TypeScript JS API, which TypeScript 7 (this
// project's tsc) no longer has, so hand it the 5.x copy frappe-ui depends on.
const fromFrappeUI = createRequire(new URL("node_modules/frappe-ui/package.json", import.meta.url));
compiler.registerTS(() => fromFrappeUI("typescript"));

/**
 * Two pages, built one at a time (npm run build): the chat (index.html, PONDER_PAGE=chat),
 * then the admin pages (admin.html, served at /admin by server/app.ts, PONDER_PAGE=admin).
 * Built apart, each page's first chunks hold only its own code; the chat, which has no
 * router, gets a stand-in for vue-router (web/no-router.ts) while /admin keeps the real one;
 * and the chat's stylesheet has only the chat's classes (tailwind.config.js).
 */
const adminBuild = process.env.PONDER_PAGE === "admin";

export default defineConfig(({ command }) => ({
	root: "web",
	plugins: [
		frappeui({ frappeProxy: false, jinjaBootData: false, buildConfig: false }),
		// Nothing the chat draws uses Vue's Options API (data, methods, mixins): its build leaves that part of Vue out.
		vue({ compiler, features: { optionsAPI: command !== "build" || adminBuild } }),
		adminPage(),
		lazyTooltipBubble(),
	],
	css: { postcss: here },
	server: devServer(),
	resolve: { alias: command === "build" && !adminBuild ? { "vue-router": `${here}web/no-router.ts` } : {} },
	build: {
		outDir: "../dist",
		// The admin build goes second, beside the chat's files.
		emptyOutDir: !adminBuild,
		target: "es2022",
		// frappe-ui's colours are lab(). For an older target the CSS carried each one twice, as a hex
		// fallback and again under @supports (lab): 85 KB of the chat's first stylesheet. These are
		// the first versions with lab(); the JS target (es2022 with class static blocks) already needs Safari 16.4.
		cssTarget: ["chrome111", "edge111", "firefox113", "safari16.4"],
		rollupOptions: { input: adminBuild ? { admin: `${here}web/admin.html` } : { main: `${here}web/index.html` } },
		// The chat's chunks by source file: the server reads which files to prefetch (server/boot-page.ts).
		manifest: !adminBuild,
	},
}));

/**
 * `npm run dev` (scripts/dev.ts): Vite serves the pages and sends the server's paths to
 * `nitro dev` on PORT. The Host header must go through as it is (Vite's shorthand changes
 * it), because Better Auth checks it against PONDER_HOSTS. No X-Forwarded headers: Vite would
 * add ",http" to a tunnel's X-Forwarded-Proto, and sign-in links would lose https.
 * Loopback only, like the server (start.sh).
 */
function devServer() {
	const api = `http://127.0.0.1:${process.env.PORT ?? 3501}`;
	// A host in PONDER_HOSTS that is not this machine, such as a tunnel, may load the pages too.
	const hosts = (process.env.PONDER_HOSTS ?? "").split(",").map((host) => host.trim().replace(/:\d+$/, ""));
	return {
		host: "127.0.0.1",
		allowedHosts: hosts.filter(Boolean),
		proxy: Object.fromEntries(["/api", "/health", "/oauth"].map((path) => [path, { target: api, changeOrigin: false }])),
	};
}

/**
 * In the chat's build, frappe-ui's Button and Tooltip get web/LazyTooltipBubble.vue in place of
 * their TooltipBubble.vue, which loads the real one the first time a tooltip opens. Should
 * frappe-ui rename the file, nothing matches and the real one is bundled as before.
 */
function lazyTooltipBubble(): Plugin {
	return {
		name: "ponder:lazy-tooltip-bubble",
		apply: "build",
		enforce: "pre",
		resolveId(source, importer) {
			if (adminBuild || !importer?.includes("/node_modules/frappe-ui/src/components/") || !source.endsWith("/TooltipBubble.vue")) return null;
			return `${here}web/LazyTooltipBubble.vue`;
		},
	};
}

/**
 * The server sends admin.html for /admin and /admin/* (server/app.ts); this does the same
 * in development. Only for a page load: the admin's own modules are under /admin/ too.
 * admin.html loads its script by an absolute address, so it works at any depth.
 */
function adminPage(): Plugin {
	return {
		name: "ponder:admin-page",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				if (/^\/admin(?:[/?]|$)/.test(req.url ?? "") && req.headers.accept?.includes("text/html")) req.url = "/admin.html";
				next();
			});
		},
	};
}
