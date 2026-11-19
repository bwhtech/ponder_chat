import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import type { UIMessage } from "ai";
import postgres from "postgres";
import { e2e } from "./env.ts";
import type { ChatScript, MemoryScript, PageScript, ReceivedCall, ReceivedSearch, ReceivedSpan, ReceivedSummary, SearchScript, SentEmail, SummaryScript } from "./fake/script.ts";
import { jsonBody } from "../server/test-json.ts";

/**
 * What the tests share:
 * - `fake` scripts the fake OpenRouter and reads what Ponder sent it (fake/server.ts).
 * - `person` signs a new person in, so each test starts with no chats and full credits.
 * - `db` is Ponder's database, for what a test can't set up through the app, such as an invite.
 *
 * Each test's browser has its own IP address in `cf-connecting-ip`, which Ponder trusts
 * (server/auth/Auth.ts), so sign-in's limits per address never stop parallel tests.
 */
export class Fake {
	/** Only what came after the test started counts, so a server kept running between runs (start.ts) does not mix them up. */
	private readonly since = Date.now();

	constructor(private readonly api: APIRequestContext) {}

	/** The reply to messages that contain `script.match`. */
	async chat(script: ChatScript) {
		await this.post("/__fake/chat", script);
	}

	async search(script: SearchScript) {
		await this.post("/__fake/search", script);
	}

	async memory(script: MemoryScript) {
		await this.post("/__fake/memory", script);
	}

	/** How the page model reads a PDF page that holds `script.match` (pdfs.ts, scanPdf). */
	async page(script: PageScript) {
		await this.post("/__fake/page", script);
	}

	/** Lets `count` page reads of a script with `hold` go, in the order they came. */
	async releasePage(match: string, count = 1) {
		await this.post("/__fake/page/release", { match, count });
	}

	/** The summary of long chats whose transcript contains `match`. */
	async summary(script: SummaryScript) {
		await this.post("/__fake/summary", script);
	}

	/** The summary calls whose transcript contains `match`. */
	async summaries(match: string): Promise<ReceivedSummary[]> {
		return jsonOf(await this.api.get(`/__fake/summaries?match=${encodeURIComponent(match)}&since=${this.since}`));
	}

	/** The chat calls whose person's latest message contains `match`. */
	async calls(match: string): Promise<ReceivedCall[]> {
		return jsonOf(await this.api.get(`/__fake/calls?match=${encodeURIComponent(match)}&since=${this.since}`));
	}

	/** The web searches whose query contains `match`, with the depth each asked for. */
	async searches(match: string): Promise<ReceivedSearch[]> {
		return jsonOf(await this.api.get(`/__fake/searches?match=${encodeURIComponent(match)}&since=${this.since}`));
	}

	/** Every span Ponder exported (server/tracing/), and each export request as it came. */
	async spans(): Promise<{ spans: ReceivedSpan[]; exports: string[] }> {
		return jsonOf(await this.api.get("/__fake/spans"));
	}

	async emails(to: string): Promise<SentEmail[]> {
		return jsonOf(await this.api.get(`/__fake/emails?to=${encodeURIComponent(to)}&since=${this.since}`));
	}

	/** The newest email to `to`, once it has come. */
	async email(to: string) {
		let latest: SentEmail | undefined;
		await expect.poll(async () => (latest = (await this.emails(to)).at(-1)), { message: `an email to ${to}` }).toBeTruthy();
		return latest!;
	}

	/** The sign-in code in the newest email to `to`. */
	async signInCode(to: string) {
		const email = await this.email(to);
		return email.subject.match(/\d{6}/)![0];
	}

	private async post(path: string, body: unknown) {
		const response = await this.api.post(path, { data: body });
		expect(response.ok()).toBe(true);
	}
}

export type Person = { id: string; email: string };

type Fixtures = { fake: Fake; person: Person; admin: Person };
type WorkerFixtures = { db: postgres.Sql };

export const test = base.extend<Fixtures, WorkerFixtures>({
	db: [
		async ({}, use) => {
			const sql = postgres(e2e.databaseUrl, { onnotice: () => {}, max: 2 });
			await use(sql);
			await sql.end();
		},
		{ scope: "worker" },
	],
	extraHTTPHeaders: async ({}, use) => {
		await use({ "cf-connecting-ip": randomIp() });
	},
	fake: async ({ playwright }, use) => {
		const api = await playwright.request.newContext({ baseURL: e2e.fakeUrl });
		await use(new Fake(api));
		await api.dispose();
	},
	person: async ({ page, db, fake }, use, testInfo) => {
		await use(await signIn(page, db, fake, uniqueEmail(testInfo.title)));
	},
	admin: async ({ page, db, fake }, use, testInfo) => {
		const person = await signIn(page, db, fake, uniqueEmail(`admin ${testInfo.title}`));
		await db`update users set role = 'admin' where id = ${person.id}`;
		await use(person);
	},
});

export { expect };

/** A made-up address for a browser, so Ponder's limits per address apply to one test only. */
/** A saved thread, as GET /api/threads/:id answers it. */
export type Thread = { messages: UIMessage[]; running: boolean; failed?: boolean; workspaceId?: string };

/**
 * A JSON answer's body, typed as the shape the test expects (server/test-json.ts). Playwright
 * types it as `any`: read it with this, not with an assertion, which `npm run lint` refuses.
 */
export const jsonOf = jsonBody;

export function randomIp() {
	return [10, ...randomBytes(3)].join(".");
}

/** An address no other test uses, readable in the logs. */
export function uniqueEmail(title: string) {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
	return `${slug}-${randomBytes(3).toString("hex")}@example.com`;
}

export async function invite(db: postgres.Sql, email: string) {
	await db`insert into allowed_emails (email, note) values (${email}, 'e2e') on conflict do nothing`;
}

/**
 * Invites the email and signs the page in with the code from the email, through Ponder's
 * sign-in API. sign-in.spec.ts tests the sign-in page itself. `baseUrl` is the Ponder
 * that the page uses, when it is not the shared one.
 */
export async function signIn(page: Page, db: postgres.Sql, fake: Fake, email: string, baseUrl = e2e.baseUrl): Promise<Person> {
	await invite(db, email);
	const headers = { origin: baseUrl };
	const sent = await page.request.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" }, headers });
	expect(sent.ok(), await sent.text()).toBe(true);
	const otp = await fake.signInCode(email);
	const signed = await page.request.post("/api/auth/sign-in/email-otp", { data: { email, otp }, headers });
	expect(signed.ok(), await signed.text()).toBe(true);
	const { user } = await jsonOf<{ user: { id: string } }>(signed);
	return { id: user.id, email };
}

/** The prompt field, and the chat's messages. */
export const chat = {
	field: (page: Page) => page.locator('[data-slot="prompt-input"] textarea'),
	messages: (page: Page) => page.locator('[data-slot="message"]'),
	reply: (page: Page) => page.locator('[data-slot="message"]').last(),
	submit: (page: Page) => page.locator('[data-slot="prompt-input-submit"]'),
	stop: (page: Page) => page.locator('[data-slot="prompt-input-submit"][aria-label="Stop"]'),

	/** Types the message, sends it with Enter, and waits until it shows in the chat. */
	async send(page: Page, text: string) {
		await chat.field(page).fill(text);
		await chat.field(page).press("Enter");
		await expect(chat.messages(page).filter({ hasText: text }).first()).toBeVisible();
	},

	/** Waits until no reply is being written. */
	async idle(page: Page) {
		await expect(chat.stop(page)).toHaveCount(0);
	},
};
