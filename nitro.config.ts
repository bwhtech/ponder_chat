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
	plugins: ["./server/plugins/startup.ts"],
	routes: { "/**": "./server/app.ts" },
});
