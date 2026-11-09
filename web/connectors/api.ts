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
export type SignInMessage = { type: "ponder:connector-sign-in"; ok: boolean; id?: string; error?: string; state?: string };

/** What each rule means, for the pickers. */
export const RULES = [
	{ label: "Always allow", value: "allow", icon: "lucide-circle-check" },
	{ label: "Ask first", value: "ask", icon: "lucide-hand" },
	{ label: "Off", value: "off", icon: "lucide-circle-off" },
];

/** Undefined until loaded. */
export const connectors = ref<Connector[] | undefined>();
/** Why the newest load of the list failed. Empty while it loads and once it loads. */
export const connectorsError = ref("");

// Each local change to a connector (an answer, a change sent, a removal) takes the next
// number. A list that was on its way during a change is older than it, so the change wins.
let sequence = 0;
const changedAt = new Map<string, number>();
const touch = (id: string) => {
	changedAt.set(id, ++sequence);
	return sequence;
};
let newestLoad = 0;
let appliedLoad = 0;

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
	const load = ++newestLoad;
	const started = sequence;
	connectorsError.value = "";
	let fresh: Connector[];
	try {
		fresh = (await request<{ connectors: Connector[] }>("")).connectors;
	} catch (error) {
		if (load === newestLoad) connectorsError.value = error instanceof Error ? error.message : "The connectors could not load.";
		throw error;
	}
	// A newer list is already shown.
	if (load < appliedLoad) return;
	appliedLoad = load;
	// Keep what changed here since this list was asked for: the list is older than it.
	const changed = (id: string) => (changedAt.get(id) ?? 0) > started;
	const local = connectors.value ?? [];
	const list = fresh.flatMap((each) => (changed(each.id) ? local.filter((mine) => mine.id === each.id) : [each]));
	for (const mine of local) if (changed(mine.id) && !fresh.some((each) => each.id === mine.id)) list.push(mine);
	connectors.value = list;
}

/** Puts a changed connector in the list, or adds it. */
function keep(connector: Connector) {
	touch(connector.id);
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

// The newest change sent for each connector. Only its answer replaces the connector, so
// quick changes (A, then B, then C) can't come back in the wrong order. An older answer
// waits here in case the newest change fails; once the newest one ends, older ones are stale.
const newestChange = new Map<string, number>();
const endedChange = new Map<string, number>();
const olderAnswer = new Map<string, { change: number; connector: Connector }>();

export async function changeConnector(id: string, change: ConnectorChange) {
	const mine = touch(id);
	newestChange.set(id, mine);
	const newest = () => newestChange.get(id) === mine;
	try {
		const { connector } = await request<{ connector: Connector }>(`/${id}`, json("PATCH", change));
		if (newest()) {
			endedChange.set(id, mine);
			olderAnswer.delete(id);
			return keep(connector);
		}
		const held = olderAnswer.get(id)?.change ?? 0;
		if (mine > held && mine > (endedChange.get(id) ?? 0)) olderAnswer.set(id, { change: mine, connector });
		return connector;
	} catch (error) {
		if (newest()) {
			// The newest change failed: the newest answer that did come is what the server has.
			const older = olderAnswer.get(id);
			endedChange.set(id, mine);
			olderAnswer.delete(id);
			if (older) keep(older.connector);
		}
		throw error;
	}
}

export async function removeConnector(id: string) {
	await request(`/${id}`, { method: "DELETE" });
	touch(id);
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
