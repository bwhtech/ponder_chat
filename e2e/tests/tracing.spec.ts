import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2e } from "../env.ts";
import type { ReceivedSpan } from "../fake/script.ts";
import { chat, expect, test, type Fake } from "../fixtures.ts";

/**
 * Traces (server/tracing/): each reply is one trace, and no span carries what the person
 * or the model wrote. Ponder sends its spans to the fake (start.ts), as it would to Jaeger.
 *
 * The privacy test puts a marker in every place content could leak from: the message,
 * a file's name and text, an address's host, path and query, a connector tool's input,
 * and the reply. Then it checks that the marker is in none of what Ponder exported.
 */
test.beforeEach(async ({ person, page }) => {
	void person;
	await page.goto("/");
});

/** Adds the test MCP server with no sign-in as "Shop" (connectors.spec.ts). */
async function addShop(page: Page) {
	const response = await page.request.post("/api/connectors", { data: { name: "Shop", url: `${e2e.mcpUrl}/open/mcp`, transport: "http", auth: "none" } });
	expect(response.ok(), await response.text()).toBe(true);
}

/** The reply's root span, once Ponder has sent it: it goes last, when the run is finished. */
async function rootOf(fake: Fake, find: (span: ReceivedSpan) => boolean) {
	let root: ReceivedSpan | undefined;
	await expect.poll(async () => (root = (await fake.spans()).spans.find((span) => span.name === "invoke_agent ponder" && find(span))), { timeout: 15_000 }).toBeTruthy();
	return root!;
}

test("keeps the reply in one trace, and no content in any span", async ({ page, fake, db, person }) => {
	const marker = `mk${randomBytes(5).toString("hex")}`;
	const url = `https://${marker}.invalid/${marker}/page?q=${marker}`;
	await addShop(page);
	await fake.chat({
		match: marker,
		steps: [
			{ reasoning: `Thinking about ${marker}.`, toolCalls: [{ name: "web_fetch", input: { url } }, { name: "shop__find_order", input: { order: marker } }] },
			{ text: `Done with ${marker}.` },
		],
	});

	await page.goto("/");
	await page.locator('[data-slot="prompt-input"] input[type="file"]').setInputFiles({ name: `${marker}-notes.txt`, mimeType: "text/plain", buffer: Buffer.from(`The code word is ${marker}.`) });
	// The person gave the address, so web_fetch reads it without asking.
	await chat.send(page, `Read ${url} and find order ${marker}`);
	await expect(chat.reply(page)).toContainText(`Done with ${marker}.`);

	const [{ run_id: runId }] = await db`select run_id from thread_runs r join threads t on t.id = r.thread_id where t.owner = ${person.id}`;
	const root = await rootOf(fake, (span) => span.attributes["workflow.run.id"] === runId);
	// Memory saves after the reply, in the background: its spans come a moment later.
	await expect.poll(async () => (await fake.spans()).spans.some((span) => span.traceId === root.traceId && span.name === "memory.save")).toBe(true);

	const { spans, exports } = await fake.spans();
	// Nowhere: not in a name, an attribute, an event, a status or a link.
	for (const body of exports) expect(body).not.toContain(marker);

	// One trace: every span of the run, from every step, has the root's trace id.
	const ofRun = spans.filter((span) => span.attributes["workflow.run.id"] === runId);
	expect(ofRun.length).toBeGreaterThan(5);
	for (const span of ofRun) expect(span.traceId).toBe(root.traceId);

	const trace = spans.filter((span) => span.traceId === root.traceId);
	const names = trace.map((span) => span.name);
	for (const name of ["credits.check", "chat.request", "queue.wait", "workflow.execute chatTurn", "thread.load", "file_context.resolve", "web_fetch.read", "mcp.call_tool", "reply.save"]) {
		expect(names, name).toContain(name);
	}
	expect(names).toContain("execute_tool web_fetch");
	// A connector's tool is named without the connector's name, which the person chose.
	expect(names).toContain("execute_tool connector__find_order");
	for (const body of exports) expect(body).not.toContain("shop__");

	// A model call has its tokens and its time to first token.
	const call = trace.find((span) => span.name.startsWith("chat ") && span.attributes["gen_ai.client.operation.time_to_first_chunk"] !== undefined);
	expect(call?.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);

	// A request to a page says where it went in kind only: no host, no address.
	const page_ = trace.find((span) => span.name === "web_fetch.read")!;
	const request = trace.find((span) => span.parentSpanId === page_.spanId && span.attributes["ponder.peer"] === "web");
	expect(request?.attributes["server.address"]).toBeUndefined();
});

test("a run that goes on after an approval is a trace of its own, linked to the first", async ({ page, fake, db, person }) => {
	await addShop(page);
	const order = `A${randomBytes(3).toString("hex")}`;
	await fake.chat({ match: order, steps: [{ toolCalls: [{ name: "shop__add_note", input: { order, note: "Gift wrap" } }] }, { text: "I added the note." }] });

	await page.goto("/");
	await chat.send(page, `Add a gift-wrap note to order ${order}`);
	await page.getByRole("button", { name: "Allow once" }).click();
	await expect(chat.reply(page)).toContainText("I added the note.");

	const [{ id: threadId }] = await db`select id from threads where owner = ${person.id}`;
	const first = await rootOf(fake, (span) => span.attributes["gen_ai.conversation.id"] === threadId && span.attributes["ponder.continued"] === false);
	const second = await rootOf(fake, (span) => span.attributes["gen_ai.conversation.id"] === threadId && span.attributes["ponder.continued"] === true);
	expect(second.traceId).not.toBe(first.traceId);

	const request = (await fake.spans()).spans.find((span) => span.traceId === second.traceId && span.name === "chat.request");
	expect(request?.links).toEqual([{ traceId: first.traceId, spanId: first.spanId }]);
});
