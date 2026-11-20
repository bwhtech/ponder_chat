import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * Sign in with Microsoft: an organisation's people sign in to Ponder with their Microsoft
 * 365 (Entra ID) work accounts. An admin sets it up on /admin, Settings, Sign-in.
 *
 * Better Auth's own Microsoft provider does the OAuth work (auth/Auth.ts): the state, PKCE
 * and the token exchange. It reads the id_token that Microsoft's token endpoint answers,
 * over TLS, for Ponder's client secret and the code. As OpenID Connect allows for a token
 * that comes this way, it does not check the token's signature. This file is Ponder's
 * part, as plain functions: what an admin sets, the checks before it is saved, and the
 * rules for who may sign in.
 *
 * The rules follow Frappe's Social Login Key for Office 365 (frappe/utils/oauth.py):
 *
 * - **One tenant.** Microsoft's sign-in serves every Entra tenant, and any tenant's admin
 *   decides what email its accounts show. So a tenant ID is required, the tenant's own
 *   endpoints are used (they sign in only that tenant's accounts), and the token must name
 *   that tenant.
 * - **The organisation's email domains.** Inside the tenant, the email is the directory's
 *   word, not a mailbox that Microsoft checked. So only emails of the domains the admin
 *   lists sign in: a directory entry with someone else's address does not open their
 *   Ponder account. This also keeps the tenant's guests out.
 * - **One Microsoft account for a Ponder account** (frappe/frappe#42500): the Microsoft
 *   account's id is saved at the first sign-in. Another Microsoft account that shows the
 *   same email later is refused (Auth.ts).
 */

/**
 * Who gets a new Ponder account when they sign in with Microsoft. "invited" is Ponder's
 * own rule: invited emails only (people/Invites.ts). "everyone" gives each person of the
 * tenant and its domains an account, with no invite.
 */
export const SIGN_UPS = ["invited", "everyone"] as const;
export type SignUps = (typeof SIGN_UPS)[number];

/** What an admin sets. */
export type MicrosoftSettings = {
	enabled: boolean;
	/** The Directory (tenant) ID of the organisation's Entra tenant. */
	tenantId: string;
	/** The Application (client) ID of the app registered for Ponder in that tenant. */
	clientId: string;
	signUps: SignUps;
	/** The organisation's email domains, such as example.org. */
	allowedDomains: ReadonlyArray<string>;
};

/**
 * The settings as /admin shows them: whether a client secret is saved, never the secret.
 * `secretUnreadable`: one is saved, but its key changed, so sign-in is off until an admin enters it again.
 */
export type MicrosoftStatus = MicrosoftSettings & { hasSecret: boolean; secretUnreadable: boolean; updatedAt: string | null };

/**
 * What sign-in runs on when Microsoft is on: the settings, with the client secret. `revision`
 * names these settings: each save makes a new one (SignInProviders.ts).
 */
export type MicrosoftProvider = Omit<MicrosoftSettings, "enabled"> & { clientSecret: string; revision: number };

export const NO_SETTINGS: MicrosoftSettings = { enabled: false, tenantId: "", clientId: "", signUps: "invited", allowedDomains: [] };

/** Better Auth's id for the provider: in its paths (/api/auth/callback/microsoft) and in `accounts`. */
export const MICROSOFT = "microsoft";

/** The path of the redirect URI that the admin registers in Entra, after the site's address. */
export const CALLBACK_PATH = `/api/auth/callback/${MICROSOFT}`;

const PROBLEMS = [
	"tenant",
	"tenant-format",
	"client-id",
	"client-id-format",
	"client-secret",
	"secret-is-id",
	"domains",
	"domain-format",
	// What Microsoft said when Ponder checked the tenant, the client and the secret (credentialsProblem).
	"tenant-unknown",
	"client-id-unknown",
	"client-secret-wrong",
	"client-secret-expired",
	"microsoft-refused",
	"microsoft-unreachable",
] as const;
export type SettingsProblem = (typeof PROBLEMS)[number];

const MESSAGES: Record<SettingsProblem, string> = {
	tenant: "Enter the Directory (tenant) ID.",
	"tenant-format": "A Directory (tenant) ID looks like 72f988bf-86f1-41af-91ab-2d7cd011db47.",
	"client-id": "Enter the Application (client) ID.",
	"client-id-format": "An Application (client) ID looks like 72f988bf-86f1-41af-91ab-2d7cd011db47.",
	"client-secret": "Enter the client secret.",
	"secret-is-id": "That is the secret's ID. Paste the secret's Value, which Entra shows once, when the secret is made.",
	domains: "Enter your organisation's email domain, such as example.org.",
	"domain-format": "Enter domains such as example.org, with no @ and no spaces.",
	"tenant-unknown": "Microsoft knows no directory with this ID.",
	"client-id-unknown": "This directory has no app with this ID.",
	"client-secret-wrong": "Microsoft does not accept this secret. Paste the secret's Value.",
	"client-secret-expired": "This secret has expired. Make a new one in Entra.",
	"microsoft-refused": "Microsoft refused these settings. Check the IDs and the secret.",
	"microsoft-unreachable": "Ponder could not reach Microsoft to check these settings. Try again.",
};

/**
 * Settings that can't be saved as they are. The message is fixed for each problem; for one
 * Microsoft refused with no fixed message, its error code goes along, to look up.
 */
export class InvalidSettings extends Schema.TaggedError<InvalidSettings>()("InvalidSettings", { problem: Schema.Literals(PROBLEMS), code: Schema.optional(Schema.String) }) {
	override get message() {
		return this.code ? `${MESSAGES[this.problem]} Microsoft said ${this.code}.` : MESSAGES[this.problem];
	}
}

/**
 * Microsoft's error codes (AADSTS…) that say which setting is wrong. Ponder asks the tenant's
 * token endpoint for a token of the app itself (client credentials): that needs the tenant,
 * the client ID and the secret to be right, and nobody to sign in. Nor does it need any API
 * permission. The redirect URI and the domains show only when a person signs in.
 */
const MICROSOFT_ERRORS: Record<number, SettingsProblem> = {
	90002: "tenant-unknown",
	900023: "tenant-unknown",
	700016: "client-id-unknown",
	7000215: "client-secret-wrong",
	7000222: "client-secret-expired",
};

/** The scope of that request: any resource's /.default does, with no permission granted. */
export const CHECK_SCOPE = "https://graph.microsoft.com/.default";

/** What the token endpoint's answer says about the settings: nothing when it gave a token. */
export function credentialsProblem(status: number, body: unknown): InvalidSettings | undefined {
	if (status === 200 && Predicate.hasProperty(body, "access_token")) return undefined;
	const codes = Predicate.hasProperty(body, "error_codes") && Array.isArray(body.error_codes) ? body.error_codes.filter(Predicate.isNumber) : [];
	const known = codes.map((code) => MICROSOFT_ERRORS[code]).find(Predicate.isNotUndefined);
	if (known) return new InvalidSettings({ problem: known });
	const code = codes[0];
	return new InvalidSettings({ problem: "microsoft-refused", ...(code !== undefined && { code: `AADSTS${code}` }) });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_DOMAINS = 50;

/**
 * The settings as they are stored: trimmed, ids and domains in lower case. Or why they
 * can't be saved. Sign-in can be on only with all of them: Frappe refuses an Office 365
 * key without a tenant at each sign-in; Ponder refuses to turn it on.
 *
 * `clientSecret` is the secret that comes with this save, if one does; `hasSecret` says
 * that one is saved already.
 */
export function checkedSettings(input: MicrosoftSettings, secret: { clientSecret: string | undefined; hasSecret: boolean }): MicrosoftSettings | InvalidSettings {
	const fail = (problem: SettingsProblem) => new InvalidSettings({ problem });
	const settings: MicrosoftSettings = {
		enabled: input.enabled,
		tenantId: input.tenantId.trim().toLowerCase(),
		clientId: input.clientId.trim().toLowerCase(),
		signUps: input.signUps,
		allowedDomains: [...new Set(input.allowedDomains.map((domain) => domain.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))],
	};
	if (settings.tenantId && !GUID.test(settings.tenantId)) return fail("tenant-format");
	if (settings.clientId && !GUID.test(settings.clientId)) return fail("client-id-format");
	if (settings.allowedDomains.length > MAX_DOMAINS || settings.allowedDomains.some((domain) => !DOMAIN.test(domain))) return fail("domain-format");
	// Entra shows a secret's ID (a GUID) beside its Value. The ID is the one that is easy to copy later, and it never works.
	if (secret.clientSecret !== undefined && GUID.test(secret.clientSecret.trim().toLowerCase())) return fail("secret-is-id");
	if (settings.enabled) {
		if (!settings.tenantId) return fail("tenant");
		if (!settings.clientId) return fail("client-id");
		if (!secret.clientSecret && !secret.hasSecret) return fail("client-secret");
		if (!settings.allowedDomains.length) return fail("domains");
	}
	return settings;
}

/** What Microsoft's id_token says about the person: its claims, as the tenant's token endpoint answered them. */
export type Profile = Readonly<Record<string, unknown>>;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The person's email, in lower case: the "email" claim, else "preferred_username". An
 * account with no mailbox has no "email" claim, and its sign-in name is an address of the
 * tenant. (Frappe reads "upn" and "unique_name" there, the names in Microsoft's older tokens.)
 */
export function emailOf(profile: Profile): string | undefined {
	const email = [profile.email, profile.preferred_username].find((value): value is string => Predicate.isString(value) && EMAIL.test(value.trim()));
	return email?.trim().toLowerCase();
}

/**
 * Why Ponder refuses this Microsoft sign-in, or nothing. The codes go to the sign-in page,
 * which has a fixed sentence for each (web/SignIn.vue).
 *
 * It runs before an account is made, before one is linked, and at every later sign-in: a
 * person whose address moved out of the organisation's domains no longer signs in.
 */
export function refusal(profile: Profile, email: string | undefined, provider: Pick<MicrosoftProvider, "tenantId" | "allowedDomains">): "WRONG_TENANT" | "EMAIL_DOMAIN_NOT_ALLOWED" | undefined {
	// The tenant's own token endpoint answered the token, so it should name that tenant. Checked all the same:
	// an Entra app that serves several tenants, or another authority, must not widen who signs in.
	if (!Predicate.isString(profile.tid) || profile.tid.toLowerCase() !== provider.tenantId) return "WRONG_TENANT";
	const domain = email?.slice(email.lastIndexOf("@") + 1).toLowerCase();
	if (!domain || !provider.allowedDomains.includes(domain)) return "EMAIL_DOMAIN_NOT_ALLOWED";
	return undefined;
}
