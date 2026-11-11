import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Ponder server that answers /api and the OAuth callback. In development the page
// runs here and the server runs on its own (npm start in the project folder, port 3500).
// The proxy keeps this page's Host, so the server builds links and callbacks (connector
// sign-in) on this address: list it in the server's PONDER_HOSTS, e.g. 127.0.0.1:5195.
const server = process.env.PONDER_SERVER ?? "http://127.0.0.1:3500";
const toServer = { target: server, changeOrigin: false, xfwd: true };

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// The icons and the manifest are the chat's own (web/public).
	publicDir: "../web/public",
	server: {
		port: Number(process.env.PORT ?? 5195),
		strictPort: true,
		host: process.env.HOST ?? "127.0.0.1",
		allowedHosts: true,
		proxy: { "/api": toServer, "/oauth": toServer },
	},
	// `npm run build` writes ../dist-astryx to look at. The root's `npm run build:astryx` builds
	// into ../dist instead, over the Vue chat's index.html, next to the admin pages.
	build: { outDir: "../dist-astryx", emptyOutDir: true, target: "es2022" },
});
