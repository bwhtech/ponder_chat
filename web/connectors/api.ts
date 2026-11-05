import { ref } from "vue";

/**
 * The person's connectors (server/mcp/): the MCP servers they connected, as the server
 * describes them. Never their credentials: header names, not values.
 */
export type Rule = "allow" | "ask" | "off";
export type ConnectorTool = { name: string; title: string | null; description: string | null; readOnly: boolean; rule: Rule; modelName: string };
export type Connector = {
	id: string;
	name: string;
	url: string;
	host: string;
	transport: "http" | "sse";
	auth: "none" | "headers" | "oauth";
	status: "connected" | "needs_sign_in" | "error";
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
export type Probe = { ok: true; transport: "http" | "sse"; auth: Connector["auth"]; name?: string; message: string } | { ok: false; message: string };
export type Header = { name: string; value: string };
export type NewConnector = { name: string; url: string; transport: Connector["transport"]; auth: Connector["auth"]; headers: Header[]; clientId?: string; clientSecret?: string };

/** What the OAuth callback page says when a sign-in ends (server/mcp/routes.ts). */
export type SignInMessage = { type: "ponder:connector-sign-in"; ok: boolean; id?: string; error?: string };

/** What each rule means, for the pickers. */
export const RULES = [
	{ label: "Always allow", value: "allow", icon: "lucide-circle-check" },
	{ label: "Ask first", value: "ask", icon: "lucide-hand" },
	{ label: "Off", value: "off", icon: "lucide-circle-off" },
];

/** Undefined until loaded. */
export const connectors = ref<Connector[] | undefined>();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/connectors${path}`, {
		...init,
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body.error ?? `The server answered ${response.status}.`);
	return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export async function loadConnectors() {
	connectors.value = (await request<{ connectors: Connector[] }>("")).connectors;
}

/** Puts a changed connector in the list, or adds it. */
function keep(connector: Connector) {
	const list = connectors.value ?? [];
	const at = list.findIndex((each) => each.id === connector.id);
	connectors.value = at === -1 ? [...list, connector] : list.map((each, i) => (i === at ? connector : each));
	return connector;
}

export const probeServer = (url: string) => request<Probe>("/probe", json("POST", { url }));

/** A connector with no sign-in or a key is added at once; OAuth returns the URL where the person signs in. */
export async function addConnector(input: NewConnector) {
	const result = await request<{ connector: Connector } | { authorizeUrl: string }>("", json("POST", input));
	if ("connector" in result) keep(result.connector);
	return result;
}

export const startSignIn = (id: string) => request<{ authorizeUrl: string }>(`/${id}/sign-in`, { method: "POST" });

export async function refreshConnector(id: string) {
	return keep((await request<{ connector: Connector }>(`/${id}/refresh`, { method: "POST" })).connector);
}

export type ConnectorChange = { name?: string; enabled?: boolean; rules?: Record<string, Rule | null>; headers?: Header[] };

export async function changeConnector(id: string, change: ConnectorChange) {
	return keep((await request<{ connector: Connector }>(`/${id}`, json("PATCH", change))).connector);
}

export async function removeConnector(id: string) {
	await request(`/${id}`, { method: "DELETE" });
	connectors.value = connectors.value?.filter((each) => each.id !== id);
}

/** "create_issue" as "Create issue", for a tool with no title. */
export const toolTitle = (tool: Pick<ConnectorTool, "name" | "title">) =>
	tool.title || tool.name.replace(/[_-]+/g, " ").replace(/^\w/, (first) => first.toUpperCase());

/** A connector tool by the name the model calls it, such as linear__create_issue. */
export function findTool(modelName: string) {
	for (const connector of connectors.value ?? []) {
		const tool = connector.tools.find((each) => each.modelName === modelName);
		if (tool) return { connector, tool };
	}
	return undefined;
}
