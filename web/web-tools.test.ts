import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { keptMode, latestWebChoice, webChoiceOf, webModeFor } from "../shared/web-mode";
import { askedWith, offersWebSearch, useWebTools, webLabel, withWebOnce } from "./web-tools";

const user = (id: string, metadata?: unknown): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }], ...(metadata !== undefined && { metadata }) });
const reply = (id: string, parts: UIMessage["parts"] = [{ type: "text", text: id }]): UIMessage => ({ id, role: "assistant", parts });

describe("a message's web choice", () => {
	it("reads the mode from metadata, and nothing from anything else", () => {
		expect(webChoiceOf({ web: "off" })).toEqual({ web: "off" });
		expect(webChoiceOf({ web: "research", keep: "off", model: "x" })).toEqual({ web: "research", keep: "off" });
		expect(webChoiceOf({ web: "research", keep: "research" })).toEqual({ web: "research" });
		for (const other of [undefined, null, "off", {}, { web: "on" }, { web: true }]) expect(webChoiceOf(other)).toBeUndefined();
	});

	it("the reply's mode is the latest message's of the person; a message with none searches, as before", () => {
		expect(webModeFor([user("a", { web: "off" }), reply("b"), user("c", { web: "research", keep: "off" })])).toBe("research");
		// A reply carried on after an approval ends on the assistant's message.
		expect(webModeFor([user("a", { web: "off" }), reply("b")])).toBe("off");
		expect(webModeFor([user("a", { web: "off" }), reply("b"), user("c")])).toBe("search");
		expect(webModeFor([])).toBe("search");
	});

	it("deep research and one-off searches are not kept", () => {
		expect(keptMode({ web: "research", keep: "off" }, "search")).toBe("off");
		expect(keptMode({ web: "research" }, "search")).toBe("search");
		expect(keptMode({ web: "search", keep: "off" }, "search")).toBe("off");
		expect(keptMode({ web: "off" }, "search")).toBe("off");
	});
});

describe("Web and Research under the message box", () => {
	it("a chat in a workspace starts with the web off, any other with it on, and a new chat follows its workspace picker", () => {
		const inWorkspace = ref(false);
		const tools = useWebTools(() => inWorkspace.value);
		expect(tools.web.value).toBe(true);
		inWorkspace.value = true;
		expect(tools.take()).toEqual({ web: "off" });
	});

	it("the person's choice stays, whatever the workspace", () => {
		const tools = useWebTools(() => true);
		tools.web.value = true;
		expect(tools.take()).toEqual({ web: "search" });
		expect(tools.take()).toEqual({ web: "search" });
	});

	it("Research is for one message, and the chat stays as it was", () => {
		const tools = useWebTools(() => true);
		tools.research.value = true;
		expect(tools.take()).toEqual({ web: "research", keep: "off" });
		expect(tools.research.value).toBe(false);
		expect(tools.take()).toEqual({ web: "off" });
	});

	it("a saved chat starts as its last message was sent", () => {
		expect(useWebTools(() => true, { web: "search" }).web.value).toBe(true);
		expect(useWebTools(() => false, { web: "off" }).web.value).toBe(false);
		// One search from "Search the web for this", or one deep research: the chat is still off.
		expect(useWebTools(() => true, { web: "search", keep: "off" }).web.value).toBe(false);
		const researched = useWebTools(() => false, { web: "research", keep: "off" });
		expect([researched.web.value, researched.research.value]).toEqual([false, false]);
	});

	it("a message that did not go out sets its choice again", () => {
		const tools = useWebTools(() => true);
		tools.research.value = true;
		const choice = tools.take();
		tools.restore(choice);
		expect([tools.web.value, tools.research.value]).toEqual([false, true]);
	});
});

describe("what a reply used", () => {
	const messages = [user("q1", { web: "off" }), reply("a1"), user("q2"), reply("a2")];

	it("is the choice of the message it answers", () => {
		expect(askedWith(messages, messages[1]!)).toEqual({ web: "off" });
		expect(askedWith(messages, messages[3]!)).toBeUndefined();
	});

	it("names Sources in a workspace, and says nothing for the usual chat", () => {
		expect(webLabel({ web: "off" }, true)).toBe("Sources only");
		expect(webLabel({ web: "search" }, true)).toBe("Sources + web");
		expect(webLabel({ web: "research", keep: "off" }, true)).toBe("Deep research");
		expect(webLabel({ web: "search" }, false)).toBeUndefined();
		expect(webLabel({ web: "off" }, false)).toBe("Web search off");
		expect(webLabel(undefined, true)).toBeUndefined();
	});
});

describe("Search the web for this", () => {
	it("a reply offers it when it called offer_web_search", () => {
		const offer = { type: "tool-offer_web_search", toolCallId: "c1", state: "output-available", input: { missing: "permits" }, output: { offered: true } } as UIMessage["parts"][number];
		expect(offersWebSearch(reply("a", [offer, { type: "text", text: "Sources don't cover permits." }]))).toBe(true);
		expect(offersWebSearch(reply("a"))).toBe(false);
	});

	it("sets only the person's latest message to one search, and keeps the rest of its metadata", () => {
		const messages = [user("q1", { web: "off" }), reply("a1"), user("q2", { web: "off", note: "kept" }), reply("a2")];
		const next = withWebOnce(messages, "off");
		expect(next[2]!.metadata).toEqual({ web: "search", keep: "off", note: "kept" });
		expect(next[0]).toBe(messages[0]);
		expect(latestWebChoice(next)).toEqual({ web: "search", keep: "off" });
	});
});
