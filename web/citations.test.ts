import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { withCitationLinks } from "./citations";

const reply = (text: string, urls: string[]): UIMessage => ({
	id: "r",
	role: "assistant",
	parts: [{ type: "text", text }, ...urls.map((url, index) => ({ type: "source-url" as const, sourceId: `s${index}`, url }))],
});
const textOf = (message: UIMessage) => (message.parts[0] as { text: string }).text;

describe("withCitationLinks", () => {
	it("links each number to its source, in the sources' order", () => {
		const linked = withCitationLinks(reply("Most leave early.[1][2] Pay helps.[2]", ["https://a.example/x", "https://b.example/y"]));
		expect(textOf(linked)).toBe("Most leave early.[[1]](<https://a.example/x>)[[2]](<https://b.example/y>) Pay helps.[[2]](<https://b.example/y>)");
	});

	it("leaves a number with no source, and one that is already a link", () => {
		const text = "See [3] and [1](https://c.example) and [[1]](<https://d.example>).";
		expect(textOf(withCitationLinks(reply(text, ["https://a.example"])))).toBe(text);
	});

	it("returns a reply with no sources as it is", () => {
		const message = reply("An answer [1].", []);
		expect(withCitationLinks(message)).toBe(message);
	});
});
