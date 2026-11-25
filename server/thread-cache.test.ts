import { describe, expect, it } from "vitest";
import { acceptedEncodings } from "./thread-cache.ts";

describe("acceptedEncodings", () => {
	it("takes what a browser names", () => {
		const takes = acceptedEncodings("gzip, deflate, br, zstd");
		expect([takes("br"), takes("gzip"), takes("identity")]).toEqual([true, true, false]);
	});

	it("refuses an encoding with a quality of 0", () => {
		const takes = acceptedEncodings("gzip, br;q=0");
		expect([takes("br"), takes("gzip")]).toEqual([false, true]);
	});

	it("reads names and qualities in any case and spacing, and * for the rest", () => {
		expect(acceptedEncodings("GZIP ; Q=0.5")("gzip")).toBe(true);
		expect(acceptedEncodings("*")("br")).toBe(true);
		expect(acceptedEncodings("*, br;q=0")("br")).toBe(false);
		expect(acceptedEncodings("")("gzip")).toBe(false);
	});
});
