import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Ponder server that answers /api. In development the page runs here and the
// server runs on its own (npm start in the project folder, port 3500).
const server = process.env.PONDER_SERVER ?? "http://127.0.0.1:3500";
// Better Auth checks the Origin of each request against PONDER_HOSTS, so the proxy
// sends the server's own origin.
const origin = new URL(server).origin.replace("127.0.0.1", "localhost");

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// The icons and the manifest are the chat's own (web/public).
	publicDir: "../web/public",
	server: {
		port: Number(process.env.PORT ?? 5195),
		strictPort: true,
		host: process.env.HOST ?? "127.0.0.1",
		allowedHosts: true,
		proxy: {
			"/api": {
				target: server,
				changeOrigin: true,
				configure: (proxy) => proxy.on("proxyReq", (request) => request.setHeader("origin", origin)),
			},
		},
	},
	build: { outDir: "../dist-astryx", emptyOutDir: true, target: "es2022" },
});
