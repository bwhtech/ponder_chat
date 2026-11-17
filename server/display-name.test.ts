import assert from "node:assert/strict";
import { test } from "vitest";
import { displayName, nameFromEmail } from "../shared/display-name.ts";

test("a person with a name keeps it, as they wrote it", () => {
	assert.equal(displayName("asha rao", "asha@example.org"), "asha rao");
	assert.equal(displayName("  Asha Rao ", "asha@example.org"), "Asha Rao");
});

test("a person with no name gets the start of their email in title case", () => {
	assert.equal(displayName("", "hussain@example.org"), "Hussain");
	assert.equal(displayName(null, "jane.doe@example.org"), "Jane Doe");
	assert.equal(displayName(undefined, "dr_sita-ram+ward@example.org"), "Dr Sita Ram Ward");
	assert.equal(nameFromEmail("ABC@example.org"), "ABC");
	assert.equal(nameFromEmail("ömer@example.org"), "Ömer");
});

test("an email start of only separators is kept as it is", () => {
	assert.equal(nameFromEmail("._@example.org"), "._");
});
