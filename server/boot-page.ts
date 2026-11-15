import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Next } from "hono";
import type { SignedIn } from "./auth.ts";
import { roleOf } from "./admins.ts";
import { creditStatus } from "./credits.ts";
import { cachedModels } from "./models.ts";
import { runPromise } from "./runtime/runtime.ts";
import { sessionOf } from "./session-cache.ts";
import { activeSkills } from "./skills.ts";
import { pythonReady } from "./startup.ts";
import * as Threads from "./threads/Threads.ts";
import { WEB_BUILD } from "./web-build.ts";

/**
 * The chat page (dist/index.html) with what its first screen needs: who is signed in, with
 * their credits, their chats, the models, the skills and the features. Without it the
 * page asks for them once its code runs, and the chats only after /api/me answers: two
 * round trips after the code, each a second or more on a slow phone network.
 *
 * The head goes out at once, so the browser fetches the code and styles while the server
 * reads the database. The data follows at the end of the body. The page's script is a
 * module, which runs only after the whole page has arrived, so the data is there when it
 * starts (web/boot.ts).
 *
 * The page is then the person's own, so no cache may keep it.
 */
export async function bootPage(c: Context, next: Next) {
	// No build (npm run dev serves the pages itself): the static files answer, as before.
	const page = await template().catch(() => undefined);
	if (!page) return next();
	const encoder = new TextEncoder();
	const headers = c.req.raw.headers;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode(page.head));
			const data = await bootData(headers, page.prefetch).catch((error: unknown) => {
				// The page still works without it: it asks the API, as before.
				console.error("boot page:", error);
				return undefined;
			});
			controller.enqueue(encoder.encode(data ? page.tail.replace("</body>", `${script(data)}</body>`) : page.tail));
			controller.close();
		},
	});
	return c.body(body, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" });
}

/** The same answers as GET /api/me, /api/threads, /api/models, /api/features and /api/skills. */
export type BootData = {
	me: Awaited<ReturnType<typeof meOf>> | null;
	threads?: Threads.ThreadSummary[];
	models?: NonNullable<ReturnType<typeof cachedModels>>;
	features?: { python: boolean };
	skills?: { name: string; description: string }[];
	/** The files of the chat's later code, for the page to prefetch once it has loaded (web/preload.ts). */
	prefetch?: string[];
};

/** GET /api/me: who is signed in, their role (read from the database, not the cookie), and their credits for today. */
export async function meOf({ id, email, name }: Pick<SignedIn, "id" | "email" | "name">) {
	const [role, credits] = await Promise.all([roleOf(id), creditStatus(id)]);
	return { user: { id, email, name, role }, credits };
}

/** GET /api/skills: the skills that are on, for the $ menu. Names and descriptions, not the instructions. */
export async function skillOptions() {
	return (await activeSkills()).map(({ name, description }) => ({ name, description }));
}

async function bootData(headers: Headers, prefetch: string[]): Promise<BootData> {
	const session = await sessionOf(headers);
	if (!session) return { me: null };
	const [me, threads, skills] = await Promise.all([meOf(session.user), runPromise(Threads.Threads.use((threads) => threads.list(session.user.id))), skillOptions()]);
	// Only what is ready now: the models wait for OpenRouter on a cold start, and the page asks for them itself then.
	const python = await settled(pythonReady);
	return { me, threads, skills, models: cachedModels(), features: python === undefined ? undefined : { python }, prefetch };
}

/** The value of a promise that has settled, or undefined: never waits. */
async function settled<T>(promise: Promise<T>): Promise<T | undefined> {
	return Promise.race([promise, Promise.resolve(undefined)]);
}

/** JSON in a script tag that never runs. "<" is escaped, so a chat's title cannot close the tag. */
function script(data: BootData) {
	return `<script type="application/json" id="ponder-boot">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

let cached: Promise<{ head: string; tail: string; prefetch: string[] }> | undefined;

/**
 * dist/index.html, read once and cut after its head. A failed read is tried again on the next
 * request. On a wide screen the head also fetches the chats panel beside the first code.
 */
function template() {
	cached ??= Promise.all([readFile(join(WEB_BUILD, "index.html"), "utf8"), chunks()]).then(
		([html, { later, panel }]) => {
			const page = panel.length ? html.replace(/(\s*)<script type="module"/, `$1${widePreload(panel)}$1<script type="module"`) : html;
			const at = page.indexOf("<body>");
			return at < 0 ? { head: page, tail: "", prefetch: later } : { head: page.slice(0, at), tail: page.slice(at), prefetch: later };
		},
		(error: unknown) => {
			cached = undefined;
			throw error;
		},
	);
	return cached;
}

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

type Manifest = Record<string, { file: string; imports?: string[]; css?: string[] }>;

/**
 * From Vite's manifest, the files of these modules that the first page does not load already:
 * `later`, the chat's later code (the AI SDK, the transcript and the API client), which the page
 * prefetches once it has loaded, so it downloads then and runs only when a chat needs it; and
 * `panel`, the chats panel's. Empty without a manifest.
 */
async function chunks(): Promise<{ later: string[]; panel: string[] }> {
	const manifest: Manifest | undefined = await readFile(join(WEB_BUILD, ".vite/manifest.json"), "utf8").then(
		(text) => JSON.parse(text) as Manifest,
		() => undefined,
	);
	if (!manifest) return { later: [], panel: [] };
	const closure = (keys: string[], seen = new Set<string>()) => {
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
