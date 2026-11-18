/**
 * The part of the screen the shell takes while a phone's keyboard is up (keyboard.ts): on iOS
 * Safari, the visible part above the keyboard; nothing on a computer, on Android (where the
 * keyboard shrinks the page itself), for the browser's own toolbar, or while zoomed in.
 */
import { assert, describe, it } from "vitest";
import { keyboardFrame } from "./keyboard.ts";

describe("keyboardFrame", () => {
	it("is the visible part above the keyboard on iOS Safari, where the page keeps its height", () => {
		assert.deepEqual(keyboardFrame({ height: 408.5, offsetTop: 112.25, scale: 1, pageHeight: 750 }), { height: 409, top: 112 });
	});

	it("is null when the page is as tall as what shows: a computer, or Android, where the keyboard shrinks the page", () => {
		assert.isNull(keyboardFrame({ height: 900, offsetTop: 0, scale: 1, pageHeight: 900 }));
		assert.isNull(keyboardFrame({ height: 420, offsetTop: 0, scale: 1, pageHeight: 420 }));
	});

	it("is null for the browser's toolbar coming and going, which 100dvh already follows", () => {
		assert.isNull(keyboardFrame({ height: 700, offsetTop: 0, scale: 1, pageHeight: 750 }));
		assert.isNull(keyboardFrame({ height: 800, offsetTop: 0, scale: 1, pageHeight: 750 }));
	});

	it("is null while the person zooms in, so pinch-zoom works as it always does", () => {
		assert.isNull(keyboardFrame({ height: 375, offsetTop: 200, scale: 2, pageHeight: 750 }));
	});
});
