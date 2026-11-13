/**
 * Connectors as the server sends them to the page (server/mcp/connectors.ts,
 * web/connectors/api.ts). Never the credentials: header names, not values.
 */
export type Transport = "http" | "sse";
export type AuthKind = "none" | "headers" | "oauth";
export type ConnectorStatus = "connected" | "needs_sign_in" | "error";
/** What Ponder does when the model calls a tool: call it, ask the person first, or leave it out. */
export type Rule = "allow" | "ask" | "off";

/**
 * The two tools the model reaches connector tools with (server/workflow/connectors.ts).
 * A call's input is { tool, input }, where tool is a ConnectorTool's modelName.
 */
export const CONNECTOR_SEARCH = "connector_search";
export const CONNECTOR_CALL = "connector_call";

export type ConnectorTool = {
	name: string;
	title: string | null;
	description: string | null;
	readOnly: boolean;
	rule: Rule;
	/** Its name in the model's catalog, such as linear__create_issue. */
	modelName: string;
};

export type ConnectorView = {
	id: string;
	name: string;
	url: string;
	host: string;
	transport: Transport;
	auth: AuthKind;
	status: ConnectorStatus;
	enabled: boolean;
	headerNames: string[];
	oauthClientId: string | null;
	serverName: string | null;
	lastError: string | null;
	toolsCheckedAt: string | null;
	lastUsedAt: string | null;
	createdAt: string;
	tools: ConnectorTool[];
};

/**
 * What the OAuth callback page tells the page that opened the sign-in. `state` is the
 * sign-in's OAuth state, so the page that waits can tell its sign-in from another. It is
 * spent by then, and the message stays on Ponder's origin.
 */
export type SignInMessage = { type: "ponder:connector-sign-in"; ok: boolean; id?: string; error?: string; state?: string };
