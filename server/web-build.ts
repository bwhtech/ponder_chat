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

/** The chat page (dist/index.html), cut after its head, and the files of its later code (boot-page.ts). */
export type Template = { head: string; tail: string; prefetch: string[] };

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
		const { later, panel } = yield* chunks;
		const page = panel.length ? html.replace(/(\s*)<script type="module"/, `$1${widePreload(panel)}$1<script type="module"`) : html;
		const at = page.indexOf("<body>");
		return at < 0 ? { head: page, tail: "", prefetch: later } : { head: page.slice(0, at), tail: page.slice(at), prefetch: later };
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
/** The chats panel, which only a wide screen draws on its first screen (web/Workspace.vue). */
const PANEL = ["ChatsPanel.vue"];

/**
 * From Vite's manifest, the files of these modules that the first page does not load already:
 * `later`, the chat's later code (the AI SDK, the transcript and the API client), which the page
 * prefetches once it has loaded, so it downloads then and runs only when a chat needs it; and
 * `panel`, the chats panel's. Empty without a manifest. A manifest that does not parse fails the
 * read, as JSON.parse did, so it is tried again.
 */
const chunks = Effect.gen(function* () {
	const text = yield* Effect.tryPromise(() => readFile(join(WEB_BUILD, ".vite/manifest.json"), "utf8")).pipe(Effect.option);
	if (Option.isNone(text)) return { later: [], panel: [] };
	const manifest = yield* Schema.decodeEffect(Manifest)(text.value).pipe(Effect.mapError((cause) => new NoWebBuild({ cause })));
	return chunksOf(manifest);
});

function chunksOf(manifest: Manifest): { later: string[]; panel: string[] } {
	const closure = (keys: readonly string[], seen = new Set<string>()) => {
		for (const key of keys) {
			if (seen.has(key) || !manifest[key]) continue;
			seen.add(key);
			closure(manifest[key].imports ?? [], seen);
		}
		return seen;
	};
	const first = closure(["index.html"]);
	const panel = closure(PANEL);
	// Each file once: what the panel brings is not fetched again with the later code.
	const files = (keys: string[], loaded: Set<string>) => {
		const own = [...closure(keys)].filter((key) => !loaded.has(key)).flatMap((key) => [manifest[key]!.file, ...(manifest[key]!.css ?? [])]);
		return [...new Set(own)].map((file) => `/${file}`);
	};
	return { later: files(LATER, new Set([...first, ...panel])), panel: files(PANEL, first) };
}
