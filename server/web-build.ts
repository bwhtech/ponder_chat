import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The web app's build, which Vite writes to dist/ and app.ts serves. The path is read
 * once, from the working directory: Nitro bundles the server into chunks, so the code's
 * own address does not tell where dist/ is. In production the service starts in the
 * release folder, which holds dist/ beside .output/ (deploy/ponder-chat.service).
 */
export const WEB_BUILD = resolve("dist");

/**
 * Without the build every page is a 404, so say why once, at start-up. In development
 * (npm run dev) Vite serves the pages, and this server's own pages do not matter.
 */
export function checkWebBuild() {
	// Nitro replaces NODE_ENV in the build, so in production this line is gone.
	if (process.env.NODE_ENV === "development") return;
	const page = join(WEB_BUILD, "index.html");
	if (existsSync(page)) return;
	console.error(`web: ${page} is missing, so this server answers 404 for every page. Run "npm run build:web", or start the server in the folder that holds dist/.`);
}
