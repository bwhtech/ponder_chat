import { describe, expect, it } from "vitest";
import { failureCause, failureReason } from "./documents";

describe("a failed document's words", () => {
	it("a table that is too wide says so on its row, and the server's limit in Details", () => {
		const error = "This table is too wide. It can have at most 500 columns.";
		expect(failureReason(error)).toBe("The table is too large");
		expect(failureCause(error)).toBe(error);
	});

	it("a reader that ran out of time or memory says so in plain words", () => {
		expect(failureReason("Reading the document timed out after 30 seconds. Try again.")).toBe("Could not read it");
		expect(failureCause("Reading the document timed out after 30 seconds. Try again.")).toBe("It took too long.");
		expect(failureReason("The document is too large or complex to read.")).toBe("Too large to read");
		expect(failureCause("The document is too large or complex to read.")).toBe("It is too large or complex to read. Split it into smaller files.");
	});

	it("a model's own error keeps the plain words", () => {
		expect(failureReason("Page 3: provider returned 500")).toBe("Could not read page 3");
		expect(failureReason("upstream exploded")).toBe("Could not read it");
		expect(failureCause("upstream exploded")).toBeNull();
	});
});
