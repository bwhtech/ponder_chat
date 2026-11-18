import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Context, Next } from "hono";
import * as Auth from "./auth/Auth.ts";
import * as Branding from "./branding/Branding.ts";
import * as Credits from "./credits/Credits.ts";
import * as Models from "./models/Models.ts";
import * as Accounts from "./people/Accounts.ts";
import { route } from "./runtime/route.ts";
import * as Skills from "./skills.ts";
import * as Sandbox from "./python/pyodide.ts";
import * as Threads from "./threads/Threads.ts";
import * as WebBuild from "./web-build.ts";
import * as Workspaces from "./workspaces/Workspaces.ts";

/**
 * The chat page (dist/index.html) with what its first screen needs: who is signed in, with
 * their credits, their chats, their workspaces, the models, the skills, the features and the logos. Without it the
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
	const page = await route(c, WebBuild.WebBuild.use((build) => build.template).pipe(Effect.option));
	if (Option.isNone(page)) return next();
	const { head, tail, prefetch } = page.value;
	const encoder = new TextEncoder();
	const headers = c.req.raw.headers;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(encoder.encode(head));
			const data = await route(
				c,
				bootData(headers, prefetch).pipe(
					// The page still works without it: it asks the API, as before.
					Effect.catchCause((cause) => Effect.as(Effect.logError("boot page:", Cause.squash(cause)), undefined)),
				),
			);
			controller.enqueue(encoder.encode(data ? tail.replace("</body>", `${script(data)}</body>`) : tail));
			controller.close();
		},
	});
	return c.body(body, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache" });
}

/** The same answers as GET /api/me, /api/threads, /api/workspaces, /api/models, /api/features, /api/skills and /api/brand. */
export type BootData = {
	me: Effect.Success<ReturnType<typeof meOf>> | null;
	/** The logos an admin set, for signed-out pages too: the sign-in page shows the logo. */
	logos: Branding.LogoVersions;
	threads?: Threads.ThreadSummary[];
	/** The sidebar's workspaces. */
	workspaces?: Workspaces.WorkspaceSummary[];
	models?: Models.Pickable;
	features?: { python: boolean };
	skills?: { name: string; description: string }[];
	/**
	 * The files of the chat's later code and of what a first tap waits for, for the page to prefetch
	 * once it has loaded (web/preload.ts). For an admin, the admin pages' files too, so the Admin
	 * item of the account menu opens them from the cache.
	 */
	prefetch?: string[];
};

/** GET /api/me: who is signed in, their role (read from the database, not the cookie), and their credits for today. */
export const meOf = Effect.fn("BootPage.me")(function* ({ id, email, name }: Pick<Auth.SignedIn, "id" | "email" | "name">) {
	const { role, credits } = yield* Effect.all(
		{ role: Accounts.Accounts.use((accounts) => accounts.roleOf(id)), credits: Credits.Credits.use((credits) => credits.status(id)) },
		{ concurrency: "unbounded" },
	);
	return { user: { id, email, name, role }, credits };
});

/** GET /api/skills: the skills that are on, for the $ menu. Names and descriptions, not the instructions. */
export const skillOptions = Skills.Skills.use((skills) => skills.active).pipe(Effect.map((skills) => skills.map(({ name, description }) => ({ name, description }))));

const bootData = Effect.fn("BootPage.data")(function* (headers: Headers, prefetch: WebBuild.Prefetch) {
	const { session, logos } = yield* Effect.all(
		{ session: Auth.Auth.use((auth) => auth.session(headers)), logos: Branding.Branding.use((branding) => branding.versions) },
		{ concurrency: "unbounded" },
	);
	if (Option.isNone(session)) return { me: null, logos } satisfies BootData;
	const { user } = session.value;
	const { me, threads, workspaces, skills } = yield* Effect.all(
		{
			me: meOf(user),
			threads: Threads.Threads.use((threads) => threads.list(user.id)),
			workspaces: Workspaces.Workspaces.use((workspaces) => workspaces.list(user.id)),
			skills: skillOptions,
		},
		{ concurrency: "unbounded" },
	);
	// Only what is ready now: the models wait for OpenRouter on a cold start, and the page asks for them itself then.
	const python = Option.getOrUndefined(yield* Sandbox.Sandbox.use((sandbox) => sandbox.readyNow));
	const models = Option.getOrUndefined(yield* Models.Models.use((models) => models.cached));
	const features = python === undefined ? undefined : { python };
	return { me, logos, threads, workspaces, skills, models, features, prefetch: prefetchFor(me.user.role, prefetch) } satisfies BootData;
});

/** Everyone's files, and for an admin the admin pages' after them: only admins can open those. */
export function prefetchFor(role: Accounts.Role, { everyone, admins }: WebBuild.Prefetch) {
	return role === "admin" ? [...everyone, ...admins] : everyone;
}

/** JSON in a script tag that never runs. "<" is escaped, so a chat's title cannot close the tag. */
function script(data: BootData) {
	return `<script type="application/json" id="ponder-boot">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}
