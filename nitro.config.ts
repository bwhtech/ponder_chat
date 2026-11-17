import { dirname, resolve } from "node:path";
import { defineConfig } from "nitro";

/**
 * The server build. Nitro bundles server/app.ts (the Hono app) and the workflow module
 * compiles "use workflow" and "use step" in server/workflow/. The web app is built by
 * Vite into dist/, which the Hono app serves.
 *
 * The workflow module also mounts /.well-known/workflow/v1/flow, where the Postgres
 * World's worker delivers runs and steps over loopback. It has no authentication: the
 * server listens on 127.0.0.1, and in production Caddy must refuse that path.
 */
export default defineConfig({
	serverDir: "./server",
	modules: ["workflow/nitro"],
	// Tracing first: its tracer must be registered before startup starts the worker.
	plugins: ["./server/plugins/tracing.ts", "./server/plugins/startup.ts"],
	routes: { "/**": "./server/app.ts" },
	// Runs each workflow delivery inside its reply's trace (server/tracing/flow-middleware.ts).
	// Not lazy: Nitro then calls it with `next`, which it needs.
	handlers: [{ route: "/.well-known/workflow/v1/flow", middleware: true, lazy: false, handler: "./server/tracing/flow-middleware.ts" }],
	buildPlugins: [workerFiles()],
	// LiteParse (workspace PDFs) loads its native core and starts its worker from files next
	// to its own, which a bundle would not have. So it stays a package in .output/server/node_modules,
	// copied whole ("*"), with its native build for this platform.
	traceDeps: ["@llamaindex/liteparse*", "@llamaindex/liteparse-linux-x64-gnu*"],
});

/**
 * A worker thread starts from a file of its own, which the bundle would not have: nothing
 * imports it. For each `new URL("./<name>-worker.ts", import.meta.url)` in the server's
 * code, this builds that file into the output and points the address at it.
 */
function workerFiles() {
	const WORKER_URL = /new URL\("(\.\/([\w-]+-worker)\.ts)", import\.meta\.url\)/g;
	type Build = { emitFile(file: { type: "chunk"; id: string; fileName: string }): string };
	return {
		name: "ponder:worker-files",
		transform(this: Build, code: string, id: string) {
			if (!code.includes("-worker.ts")) return;
			return code.replace(WORKER_URL, (_, path: string, name: string) => {
				const reference = this.emitFile({ type: "chunk", id: resolve(dirname(id), path), fileName: `_workers/${name}.mjs` });
				return `new URL(import.meta.ROLLUP_FILE_URL_${reference})`;
			});
		},
	};
}
