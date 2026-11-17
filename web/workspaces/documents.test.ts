import { describe, expect, it } from "vitest";
import { failureCause, failureReason } from "./documents";

describe("a failed document's words", () => {
	it("a table that is too wide says so on its row, and the server's limit in Details", () => {
		const error = "This table is too wide. It can have at most 500 columns.";
		expect(failureReason(error)).toBe("The table is too large");
		expect(failureCause(error)).toBe(error);
	});

	it("a model's own error keeps the plain words", () => {
		expect(failureReason("Page 3: provider returned 500")).toBe("Could not read page 3");
		expect(failureReason("upstream exploded")).toBe("Could not read it");
		expect(failureCause("upstream exploded")).toBeNull();
	});
});
