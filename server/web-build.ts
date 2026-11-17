import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as PonderConfig from "./config.ts";

/**
 * The web app's build, which Vite writes to dist/ and app.ts serves. The path is read
 * once, from the working directory: Nitro bundles the server into chunks, so the code's
 * own address does not tell where dist/ is. In production the service starts in the
 * release folder, which holds dist/ beside .output/ (deploy/ponder-chat.service).
 */
export const WEB_BUILD = resolve("dist");

/** The chat page (dist/index.html), cut after its head, and the files it prefetches once it has loaded (boot-page.ts). */
export type Template = { head: string; tail: string; prefetch: Prefetch };

/** The files to prefetch: `everyone`'s for each chat page, and `admins`' as well for an admin. No file is in both. */
export type Prefetch = { everyone: string[]; admins: string[] };

/** dist/index.html could not be read: there is no build (npm run dev serves the pages itself). */
export class NoWebBuild extends Schema.TaggedError<NoWebBuild>()("NoWebBuild", { cause: Schema.Defect() }) {
	override get message() {
		return "The web app's build could not be read.";
	}
}

const ManifestEntry = Schema.Struct({ file: Schema.String, imports: Schema.optional(Schema.Array(Schema.String)), css: Schema.optional(Schema.Array(Schema.String)) });
const Manifest = Schema.fromJsonString(Schema.Record(Schema.String, ManifestEntry));
type Manifest = typeof Manifest.Type;

export class WebBuild extends Context.Service<
	WebBuild,
	{
		/**
		 * Without the build every page is a 404, so say why once, at start-up. In development
		 * (npm run dev) Vite serves the pages, and this server's own pages do not matter.
		 */
		readonly check: Effect.Effect<void>;
		/**
		 * dist/index.html, read once and cut after its head. A failed read is tried again on the next
		 * request. On a wide screen the head also fetches the chats panel beside the first code.
		 */
		readonly template: Effect.Effect<Template, NoWebBuild>;
	}
>()("ponder/web/WebBuild") {}

const make = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	const cached = yield* SynchronizedRef.make(Option.none<Template>());

	const check = Effect.gen(function* () {
		// Nitro replaces NODE_ENV in the build, so in production this is never true.
		if (config.development) return;
		const page = join(WEB_BUILD, "index.html");
		if (yield* Effect.sync(() => existsSync(page))) return;
		yield* Effect.logError(`web: ${page} is missing, so this server answers 404 for every page. Run "npm run build:web", or start the server in the folder that holds dist/.`);
	});

	const read = Effect.gen(function* () {
		const html = yield* Effect.tryPromise({ try: () => readFile(join(WEB_BUILD, "index.html"), "utf8"), catch: (cause) => new NoWebBuild({ cause }) });
		const { later, panel, admin } = chunksOf(yield* manifest(".vite/manifest.json"), yield* manifest(".vite/admin-manifest.json"));
		const page = panel.length ? html.replace(/(\s*)<script type="module"/, `$1${widePreload(panel)}$1<script type="module"`) : html;
		const at = page.indexOf("<body>");
		const prefetch = { everyone: later, admins: admin };
		return at < 0 ? { head: page, tail: "", prefetch } : { head: page.slice(0, at), tail: page.slice(at), prefetch };
	});

	// Once read, the page is kept; requests that come while it is read wait for the one read.
	const template = Effect.gen(function* () {
		const known = yield* SynchronizedRef.get(cached);
		if (Option.isSome(known)) return known.value;
		return yield* SynchronizedRef.modifyEffect(cached, (current) =>
			Option.isSome(current) ? Effect.succeed([current.value, current] as const) : Effect.map(read, (page) => [page, Option.some(page)] as const),
		);
	});

	return WebBuild.of({ check, template });
});

export const layer = Layer.effect(WebBuild, make);

/**
 * The chats panel (web/ChatsPanel.vue) is its own chunk, since a phone draws it only in its
 * bottom sheet. A wide screen draws it at once, so the page fetches it with the first code there,
 * with links like the modulepreload links Vite writes. `media` keeps phones from fetching it.
 */
function widePreload(files: string[]) {
	const wide = 'media="(min-width: 768px)"';
	return files.map((href) => (href.endsWith(".css") ? `<link rel="stylesheet" crossorigin href="${href}" ${wide}>` : `<link rel="modulepreload" crossorigin href="${href}" ${wide}>`)).join("");
}

/** The modules a chat loads after its first screen (web/preload.ts, web/api.ts, ChatView.vue), by their source file. */
const LATER = ["chat-sdk.ts", "transcript.ts", "api-client.ts", "thinking.ts", "attention.ts"];
/**
 * The modules that a first tap waits for, most used first: the model menu (web/models.ts), a
 * confirm dialog (web/dialogs.ts), settings, the side panel and memory (web/Shell.vue), a
 * workspace's page, its dialogs and the composer's workspace menu (web/workspaces/), a toast,
 * the $ menu, the alerts, the Markdown export and a tooltip. Not the sign-in page, which
 * a signed-in page never draws, nor PDF pages and code languages, which are large and rare.
 */
const ON_TAP = [
	"model-selector.ts",
	"dialogs-host.ts",
	"settings/SettingsModal.vue",
	"side-panel/SidePanel.vue",
	"MemoryView.vue",
	"workspaces/WorkspacePage.vue",
	"workspaces/WorkspaceDialogs.vue",
	"workspaces/WorkspacePicker.vue",
	"toasts-host.ts",
	"skills/SkillMenu.vue",
	"alert.ts",
	"OutOfCredits.vue",
	"export-markdown.ts",
	"../node_modules/frappe-ui/src/components/Tooltip/TooltipBubble.vue",
];
/** The chats panel, which only a wide screen draws on its first screen (web/Shell.vue). */
const PANEL = ["ChatsPanel.vue"];
/** The admin pages' first code and styles, and the overview's, the page /admin opens on (web/admin/router.ts). */
const ADMIN = ["admin.html", "admin/pages/Overview.vue"];

/**
 * A build's manifest (vite.config.ts), empty when there is none. One that does not parse fails
 * the read, as JSON.parse did, so it is tried again.
 */
const manifest = Effect.fn("WebBuild.manifest")(function* (path: string) {
	const text = yield* Effect.tryPromise(() => readFile(join(WEB_BUILD, path), "utf8")).pipe(Effect.option);
	if (Option.isNone(text)) return {};
	return yield* Schema.decodeEffect(Manifest)(text.value).pipe(Effect.mapError((cause) => new NoWebBuild({ cause })));
});

/**
 * From the manifests of the chat (`chat`) and of the admin pages (`admin`), the files of these
 * modules that the first page does not load already: `later`, the chat's later code and what a
 * first tap waits for, which the page prefetches once it has loaded, so it downloads then and
 * runs only when needed; `panel`, the chats panel's; and `admin`, the admin pages', which only an
 * admin prefetches. Each file is listed once. The admin pages are a build of their own, so their
 * files are only the chat's when the two builds made the same file.
 */
export function chunksOf(chat: Manifest, admin: Manifest): { later: string[]; panel: string[]; admin: string[] } {
	const first = closure(chat, ["index.html"]);
	const panel = files(chat, PANEL, first);
	// What the panel brings is not fetched again with the later code.
	const later = files(chat, [...LATER, ...ON_TAP], new Set([...first, ...closure(chat, PANEL)]));
	// Split by page, /admin has Vue's chunks under the same names as the chat's.
	const chats = new Set([...filesOf(chat, first), ...panel, ...later]);
	return { later, panel, admin: files(admin, ADMIN, new Set()).filter((file) => !chats.has(file)) };
}

/** The files of `keys` and of what they import, without those of the modules in `loaded`. */
function files(manifest: Manifest, keys: string[], loaded: Set<string>) {
	return filesOf(manifest, [...closure(manifest, keys)].filter((key) => !loaded.has(key)));
}

/** The files of these modules and their styles, each once, as the page asks for them. */
function filesOf(manifest: Manifest, keys: Iterable<string>) {
	const own = [...keys].flatMap((key) => [manifest[key]!.file, ...(manifest[key]!.css ?? [])]);
	return [...new Set(own)].map((file) => `/${file}`);
}

/** The modules of `keys` and those they import, in that order. Keys a build does not have are left out. */
function closure(manifest: Manifest, keys: readonly string[], seen = new Set<string>()) {
	for (const key of keys) {
		if (seen.has(key) || !manifest[key]) continue;
		seen.add(key);
		closure(manifest, manifest[key].imports ?? [], seen);
	}
	return seen;
}
