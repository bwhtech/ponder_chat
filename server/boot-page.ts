import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Next } from "hono";
import { auth, type SignedIn } from "./auth.ts";
import { roleOf } from "./admins.ts";
import { creditStatus } from "./credits.ts";
import { listThreads } from "./db.ts";
import { cachedModels } from "./models.ts";
import { activeSkills } from "./skills.ts";
import { pythonReady } from "./startup.ts";
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
			const data = await bootData(headers).catch((error: unknown) => {
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
	threads?: Awaited<ReturnType<typeof listThreads>>;
	models?: NonNullable<ReturnType<typeof cachedModels>>;
	features?: { python: boolean };
	skills?: { name: string; description: string }[];
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

async function bootData(headers: Headers): Promise<BootData> {
	const session = await auth.api.getSession({ headers });
	if (!session) return { me: null };
	const [me, threads, skills] = await Promise.all([meOf(session.user), listThreads(session.user.id), skillOptions()]);
	// Only what is ready now: the models wait for OpenRouter on a cold start, and the page asks for them itself then.
	const python = await settled(pythonReady);
	return { me, threads, skills, models: cachedModels(), features: python === undefined ? undefined : { python } };
}

/** The value of a promise that has settled, or undefined: never waits. */
async function settled<T>(promise: Promise<T>): Promise<T | undefined> {
	return Promise.race([promise, Promise.resolve(undefined)]);
}

/** JSON in a script tag that never runs. "<" is escaped, so a chat's title cannot close the tag. */
function script(data: BootData) {
	return `<script type="application/json" id="ponder-boot">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

let cached: Promise<{ head: string; tail: string }> | undefined;

/** dist/index.html, read once and cut after its head. A failed read is tried again on the next request. */
function template() {
	cached ??= readFile(join(WEB_BUILD, "index.html"), "utf8").then(
		(html) => {
			const at = html.indexOf("<body>");
			return at < 0 ? { head: html, tail: "" } : { head: html.slice(0, at), tail: html.slice(at) };
		},
		(error: unknown) => {
			cached = undefined;
			throw error;
		},
	);
	return cached;
}
