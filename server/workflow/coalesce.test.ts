import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { describe, expect, it } from "vitest";
import { CoalescingWriter } from "./coalesce.ts";

/** A writer that records what reaches it, as the durable stream would get it. */
function sink() {
	const parts: unknown[] = [];
	const writer = new WritableStream<ModelCallStreamPart>({ write: (part) => void parts.push(part) }).getWriter();
	return { parts, writer };
}
const text = (id: string, value: string) => ({ type: "text-delta", id, text: value }) as unknown as ModelCallStreamPart;
const part = (type: string, extra: object = {}) => ({ type, ...extra }) as unknown as ModelCallStreamPart;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("CoalescingWriter", () => {
	it("writes the first piece at once, and joins the next ones", async () => {
		const { parts, writer } = sink();
		const out = new CoalescingWriter(writer, 20);
		await out.write(part("text-start", { id: "t" }));
		await out.write(text("t", "Hel"));
		expect(parts).toEqual([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", text: "Hel" }]);
		await out.write(text("t", "lo "));
		await out.write(text("t", "world"));
		expect(parts).toHaveLength(2);
		await out.write(part("text-end", { id: "t" }));
		expect(parts).toEqual([
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", text: "Hel" },
			{ type: "text-delta", id: "t", text: "lo world" },
			{ type: "text-end", id: "t" },
		]);
	});

	it("writes what waits after the window, without another part", async () => {
		const { parts, writer } = sink();
		const out = new CoalescingWriter(writer, 10);
		await out.write(text("t", "a"));
		await out.write(text("t", "b"));
		await wait(30);
		expect(parts).toEqual([text("t", "a"), text("t", "b")]);
	});

	it("keeps pieces of different kinds and ids apart, in order", async () => {
		const { parts, writer } = sink();
		const out = new CoalescingWriter(writer, 50);
		await out.write(part("reasoning-delta", { id: "r", text: "think" }));
		await out.write(part("reasoning-delta", { id: "r", text: "ing" }));
		await out.write(text("t", "Hi"));
		await out.write(part("tool-input-delta", { id: "c", delta: '{"q"' }));
		await out.write(part("tool-input-delta", { id: "c", delta: ':"x"}' }));
		await out.flush();
		expect(parts).toEqual([
			{ type: "reasoning-delta", id: "r", text: "think" },
			{ type: "reasoning-delta", id: "r", text: "ing" },
			text("t", "Hi"),
			{ type: "tool-input-delta", id: "c", delta: '{"q"' },
			{ type: "tool-input-delta", id: "c", delta: ':"x"}' },
		]);
	});

	it("never joins a piece with provider metadata", async () => {
		const { parts, writer } = sink();
		const out = new CoalescingWriter(writer, 50);
		await out.write(part("reasoning-delta", { id: "r", text: "a" }));
		await out.write(part("reasoning-delta", { id: "r", text: "b" }));
		await out.write(part("reasoning-delta", { id: "r", text: "", providerMetadata: { anthropic: { signature: "s" } } }));
		await out.flush();
		expect(parts).toHaveLength(3);
		expect(parts[2]).toMatchObject({ providerMetadata: { anthropic: { signature: "s" } } });
	});

	it("fails the next write after a failed one", async () => {
		let calls = 0;
		const writer = new WritableStream<ModelCallStreamPart>({
			write: () => {
				if (++calls === 2) throw new Error("database down");
			},
		}).getWriter();
		const out = new CoalescingWriter(writer, 5);
		await out.write(text("t", "a"));
		await out.write(text("t", "b"));
		await expect(out.flush()).rejects.toThrow("database down");
	});
});
