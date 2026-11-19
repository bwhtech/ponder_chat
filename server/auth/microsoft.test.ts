/**
 * The plain rules of sign-in with Microsoft: what an admin may save, the email Ponder
 * reads from a token, and who is refused. The whole sign-in is in microsoft-sign-in.test.ts.
 */
import { assert, describe, it } from "@effect/vitest";
import { checkedSettings, emailOf, InvalidSettings, refusal, type MicrosoftSettings } from "./microsoft.ts";

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const on: MicrosoftSettings = { enabled: true, tenantId: TENANT, clientId: CLIENT, signUps: "invited", allowedDomains: ["example.org"] };
const off: MicrosoftSettings = { enabled: false, tenantId: "", clientId: "", signUps: "invited", allowedDomains: [] };
type Secret = { clientSecret: string | undefined; hasSecret: boolean };
const withSecret: Secret = { clientSecret: "Abc8Q~a-real-looking-secret-value", hasSecret: false };
const noSecret: Secret = { clientSecret: undefined, hasSecret: false };

const problemOf = (input: MicrosoftSettings, secret: Secret = withSecret) => {
	const checked = checkedSettings(input, secret);
	return checked instanceof InvalidSettings ? checked.problem : undefined;
};

describe("checkedSettings", () => {
	it("saves empty settings while sign-in is off", () => {
		assert.deepStrictEqual(checkedSettings(off, noSecret), off);
	});

	it("stores ids and domains trimmed, in lower case, each domain once", () => {
		const checked = checkedSettings({ ...on, tenantId: ` ${TENANT.toUpperCase()} `, clientId: CLIENT.toUpperCase(), allowedDomains: [" Example.ORG ", "@example.org", "", "mail.example.co.in"] }, withSecret);
		assert.deepStrictEqual(checked, { ...on, allowedDomains: ["example.org", "mail.example.co.in"] });
	});

	it("turns on only with a tenant, a client ID, a client secret and a domain", () => {
		// Frappe refuses an Office 365 key with no tenant at each sign-in. Ponder refuses to turn it on.
		assert.strictEqual(problemOf({ ...on, tenantId: "" }), "tenant");
		assert.strictEqual(problemOf({ ...on, clientId: "" }), "client-id");
		assert.strictEqual(problemOf(on, noSecret), "client-secret");
		assert.strictEqual(problemOf({ ...on, allowedDomains: [] }), "domains");
		assert.isUndefined(problemOf(on));
		// A secret saved before counts.
		assert.isUndefined(problemOf(on, { clientSecret: undefined, hasSecret: true }));
	});

	it("takes a tenant only as its id: a name, or all of Microsoft, would let other tenants in", () => {
		for (const tenantId of ["common", "organizations", "consumers", "contoso.onmicrosoft.com", "1234"]) assert.strictEqual(problemOf({ ...on, tenantId }), "tenant-format", tenantId);
		assert.strictEqual(problemOf({ ...off, tenantId: "common" }, noSecret), "tenant-format");
		assert.strictEqual(problemOf({ ...on, clientId: "ponder-chat" }), "client-id-format");
	});

	it("says so when the secret's ID is pasted in place of its value", () => {
		assert.strictEqual(problemOf(on, { clientSecret: "0f8fad5b-d9cb-469f-a165-70867728950e", hasSecret: true }), "secret-is-id");
	});

	it("refuses what is not a domain", () => {
		for (const domain of ["ana@example.org", "example", "exa mple.org", "https://example.org", "*.example.org", "-bad.example.org"])
			assert.strictEqual(problemOf({ ...on, allowedDomains: [domain] }), "domain-format", domain);
		assert.strictEqual(problemOf({ ...on, allowedDomains: Array.from({ length: 51 }, (_, index) => `d${index}.example.org`) }), "domain-format");
	});

	it("has a fixed sentence for each problem", () => {
		const checked = checkedSettings({ ...on, tenantId: "" }, withSecret);
		assert.instanceOf(checked, InvalidSettings);
		assert.strictEqual(checked instanceof InvalidSettings && checked.message, "Enter the Directory (tenant) ID.");
	});
});

describe("emailOf", () => {
	it("reads the email in lower case", () => {
		assert.strictEqual(emailOf({ email: " Ana@Example.ORG ", preferred_username: "ana.other@example.org" }), "ana@example.org");
	});

	it("reads the sign-in name of an account with no mailbox", () => {
		assert.strictEqual(emailOf({ preferred_username: "Bo@Example.org" }), "bo@example.org");
		assert.strictEqual(emailOf({ email: "", preferred_username: "bo@example.org" }), "bo@example.org");
	});

	it("finds no email in a user name, a number or nothing", () => {
		assert.isUndefined(emailOf({ preferred_username: "bo" }));
		assert.isUndefined(emailOf({ email: 42, preferred_username: null }));
		assert.isUndefined(emailOf({}));
	});
});

describe("refusal", () => {
	const provider = { tenantId: TENANT, allowedDomains: ["example.org", "example.com"] };

	it("lets in a person of the tenant with an email of its domains", () => {
		assert.isUndefined(refusal({ tid: TENANT }, "ana@example.org", provider));
		assert.isUndefined(refusal({ tid: TENANT.toUpperCase() }, "ana@example.com", provider));
	});

	it("refuses another tenant, and a token that names none", () => {
		assert.strictEqual(refusal({ tid: "99999999-2222-4333-8444-555555555555" }, "ana@example.org", provider), "WRONG_TENANT");
		assert.strictEqual(refusal({}, "ana@example.org", provider), "WRONG_TENANT");
		assert.strictEqual(refusal({ tid: 7 }, "ana@example.org", provider), "WRONG_TENANT");
	});

	it("refuses an email of another domain, a subdomain, a look-alike, and no email", () => {
		for (const email of ["ana@elsewhere.example", "ana@mail.example.org", "ana@notexample.org", "ana@example.org.evil.example", "example.org@evil.example"])
			assert.strictEqual(refusal({ tid: TENANT }, email, provider), "EMAIL_DOMAIN_NOT_ALLOWED", email);
		assert.strictEqual(refusal({ tid: TENANT }, undefined, provider), "EMAIL_DOMAIN_NOT_ALLOWED");
	});

	it("refuses everyone when no domain is set", () => {
		assert.strictEqual(refusal({ tid: TENANT }, "ana@example.org", { tenantId: TENANT, allowedDomains: [] }), "EMAIL_DOMAIN_NOT_ALLOWED");
	});
});
