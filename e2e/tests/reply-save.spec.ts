import { randomUUID } from "node:crypto";
import type { ReceivedSpan } from "../fake/script.ts";
import { expect, test } from "../fixtures.ts";

/**
 * Saving a reply (server/workflow/reply.ts) replays the run's stream. A tool call's input
 * comes in many small pieces, and the AI SDK parses the whole input so far at each one,
 * so a long input saved in time quadratic in its length and held the server. The save
 * now joins the pieces first (joinToolInputDeltas).
 *
 * The reply is asked for through the API, and no page reads it: the browser's copy of the
 * SDK pays the same cost, and only the server's save is under test.
 */
test.beforeEach(async ({ person }) => {
	void person;
});

test("a reply with a 400 KB tool input in 10,000 pieces saves in a few seconds at most", async ({ page, fake }) => {
	test.setTimeout(120_000);
	const content = Array.from({ length: 80_000 }, (_, i) => `note${i % 97}`).join(" ").slice(0, 400_000);
	await fake.chat({
		match: "SAVE-BIG",
		// The fake streams a tool call's arguments 40 characters at a time: about 10,000 pieces.
		steps: [{ toolCalls: [{ name: "write_artifact", input: { id: "big", kind: "document", title: "Big", content } }], delayMs: 0 }, { text: "SAVE-DONE" }],
	});

	const threadId = randomUUID().slice(0, 8);
	const message = { id: randomUUID(), role: "user", parts: [{ type: "text", text: "SAVE-BIG write it all down" }] };
	const response = await page.request.post("/api/chat", { data: { id: threadId, messages: [message] }, timeout: 90_000 });
	expect(response.ok(), await response.text()).toBe(true);
	const runId = response.headers()["x-workflow-run-id"];

	// The reply is saved whole: the artifact's input and the answer after it.
	await expect
		.poll(async () => JSON.stringify((await (await page.request.get(`/api/threads/${threadId}`)).json()).messages ?? []), { timeout: 60_000 })
		.toContain("SAVE-DONE");
	const saved = JSON.stringify((await (await page.request.get(`/api/threads/${threadId}`)).json()).messages);
	expect(saved).toContain(content.slice(-200));

	let root: ReceivedSpan | undefined;
	await expect.poll(async () => (root = (await fake.spans()).spans.find((span) => span.name === "invoke_agent ponder" && span.attributes["workflow.run.id"] === runId)), { timeout: 15_000 }).toBeTruthy();
	const save = (await fake.spans()).spans.find((span) => span.traceId === root!.traceId && span.name === "reply.save");
	// Before the join, this save took about 20 seconds, and the server answered nothing meanwhile.
	// The span also covers the database writes, which took the save to 1.2 seconds on a loaded CI runner, so the limit is 5.
	expect(save?.durationMs).toBeLessThan(5_000);
});
