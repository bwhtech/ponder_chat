/**
 * The files the chat page prefetches (web-build.ts, boot-page.ts), from small manifests in
 * Vite's shape: each file once, none the first page loads already, the admin pages' only for an
 * admin, and the same with /admin as one chunk or split by page.
 */
import { assert, describe, it } from "@effect/vitest";
import { prefetchFor } from "./boot-page.ts";
import { chunksOf } from "./web-build.ts";

const chat = {
	"index.html": { file: "assets/main.js", imports: ["_vue.js"], css: ["assets/main.css"] },
	"_vue.js": { file: "assets/vue.js" },
	"_shared.js": { file: "assets/shared.js", imports: ["_vue.js"] },
	"ChatsPanel.vue": { file: "assets/ChatsPanel.js", imports: ["_vue.js", "_panel-list.js"] },
	"_panel-list.js": { file: "assets/panel-list.js" },
	"chat-sdk.ts": { file: "assets/chat-sdk.js", imports: ["_shared.js"] },
	"transcript.ts": { file: "assets/transcript.js", imports: ["_shared.js", "_panel-list.js"], css: ["assets/transcript.css"] },
	"model-selector.ts": { file: "assets/model-selector.js", imports: ["_shared.js"] },
	"dialogs-host.ts": { file: "assets/dialogs-host.js", imports: ["_vue.js"] },
	"settings/SettingsModal.vue": { file: "assets/SettingsModal.js", imports: ["_shared.js"], css: ["assets/SettingsModal.css"] },
	"SignIn.vue": { file: "assets/SignIn.js" },
};

// /admin as one chunk, as before it was split by page.
const adminWhole = {
	"admin.html": { file: "assets/admin.js", css: ["assets/admin.css"] },
};

// /admin split by page: the overview is its own chunk, and the other pages are left for later.
const adminSplit = {
	"admin.html": { file: "assets/admin.js", imports: ["_frappe-ui.js"], css: ["assets/admin.css"] },
	"_frappe-ui.js": { file: "assets/frappe-ui.js" },
	"admin/pages/Overview.vue": { file: "assets/Overview.js", imports: ["_frappe-ui.js", "_chart.js"], css: ["assets/Overview.css"] },
	"_chart.js": { file: "assets/chart.js" },
	"admin/pages/People.vue": { file: "assets/People.js", imports: ["_frappe-ui.js"] },
};

describe("chunksOf", () => {
	it("lists the chat's later code and what a tap waits for, without the first page's files or the panel's", () => {
		const { later, panel } = chunksOf(chat, adminWhole);
		assert.deepStrictEqual(panel, ["/assets/ChatsPanel.js", "/assets/panel-list.js"]);
		assert.deepStrictEqual(later, [
			"/assets/chat-sdk.js",
			"/assets/shared.js",
			"/assets/transcript.js",
			"/assets/transcript.css",
			"/assets/model-selector.js",
			"/assets/dialogs-host.js",
			"/assets/SettingsModal.js",
			"/assets/SettingsModal.css",
		]);
	});

	it("lists /admin's entry, its imports, its styles and the overview, whether or not it is split", () => {
		assert.deepStrictEqual(chunksOf(chat, adminWhole).admin, ["/assets/admin.js", "/assets/admin.css"]);
		assert.deepStrictEqual(chunksOf(chat, adminSplit).admin, [
			"/assets/admin.js",
			"/assets/admin.css",
			"/assets/frappe-ui.js",
			"/assets/Overview.js",
			"/assets/Overview.css",
			"/assets/chart.js",
		]);
	});

	it("leaves out an admin file the chat's build made too", () => {
		const admin = { "admin.html": { file: "assets/admin.js", imports: ["_vue.js", "_shared.js"] }, "_vue.js": { file: "assets/vue.js" }, "_shared.js": { file: "assets/shared.js" } };
		assert.deepStrictEqual(chunksOf(chat, admin).admin, ["/assets/admin.js"]);
	});

	it("lists nothing without the manifests", () => {
		assert.deepStrictEqual(chunksOf({}, {}), { later: [], panel: [], admin: [] });
	});
});

describe("prefetchFor", () => {
	const prefetch = { everyone: ["/assets/chat-sdk.js"], admins: ["/assets/admin.js"] };

	it("gives an org admin and a team admin the admin pages' files after everyone's", () => {
		assert.deepStrictEqual(prefetchFor("org", prefetch), ["/assets/chat-sdk.js", "/assets/admin.js"]);
		assert.deepStrictEqual(prefetchFor("team", prefetch), ["/assets/chat-sdk.js", "/assets/admin.js"]);
	});

	it("gives anyone else only everyone's", () => {
		assert.deepStrictEqual(prefetchFor(null, prefetch), ["/assets/chat-sdk.js"]);
	});
});
