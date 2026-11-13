import { createHash, randomUUID } from "node:crypto";
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import { sql } from "../db.ts";
import { seal, unseal, UnreadableSecret } from "../secrets.ts";
import type { AuthKind, ConnectorStatus as Status, Rule, Transport } from "../../shared/connectors.ts";

/**
 * Connectors: the MCP servers each person connected, in Postgres. Every query is here.
 *
 * - mcp_connections: one row for each server a person connected. The credentials (header
 *   values, OAuth client and tokens) are one sealed JSON value (secrets.ts), bound to
 *   the row. What is not secret (status, expiry, tools, rules) is in plain columns.
 * - mcp_sign_ins: OAuth sign-ins in progress, for 10 minutes. Only a hash of the OAuth
 *   state is kept; the state itself is only in the URL.
 *
 * Deleting a person deletes their connections and sign-ins.
 */
export type { AuthKind, Rule, Status, Transport };

/** A tool as the server listed it, kept as plain data. */
export type ToolInfo = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
	destructive: boolean;
};

export type ServerInfo = { name?: string; title?: string; version?: string; instructions?: string };

export type Credentials = {
	headers?: Record<string, string>;
	client?: OAuthClientInformation;
	/** The client came from dynamic registration, so the SDK may register again when it is refused. */
	clientIsDynamic?: boolean;
	authServer?: OAuthAuthorizationServerInformation;
	tokens?: OAuthTokens;
};

export type Connection = {
	id: string;
	userId: string;
	name: string;
	/** The start of each of its tool names, such as linear__create_issue. Never changes. */
	slug: string;
	url: string;
	transport: Transport;
	auth: AuthKind;
	status: Status;
	enabled: boolean;
	headerNames: string[];
	/** The client ID of the person's own OAuth app. Null when Ponder registered itself. */
	oauthClientId: string | null;
	expiresAt: Date | null;
	serverInfo: ServerInfo | null;
	tools: ToolInfo[];
	toolsCheckedAt: Date | null;
	toolRules: Record<string, Rule>;
	lastError: string | null;
	lastUsedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	/** Sealed. Read it with readCredentials. */
	sealed: string | null;
};

export async function migrateConnectors() {
	await sql`
		create table if not exists mcp_connections (
			id text primary key,
			user_id text not null references users (id) on delete cascade,
			name text not null,
			slug text not null,
			url text not null,
			transport text not null default 'http' check (transport in ('http', 'sse')),
			auth text not null check (auth in ('none', 'headers', 'oauth')),
			status text not null default 'connected' check (status in ('connected', 'needs_sign_in', 'error')),
			enabled boolean not null default true,
			credentials text,
			header_names text[] not null default '{}',
			oauth_client_id text,
			expires_at timestamptz,
			server_info jsonb,
			tools jsonb not null default '[]',
			tools_checked_at timestamptz,
			tool_rules jsonb not null default '{}',
			last_error text,
			last_used_at timestamptz,
			created_at timestamptz not null default now(),
			updated_at timestamptz not null default now(),
			unique (user_id, slug),
			unique (user_id, url)
		)`;
	await sql`
		create table if not exists mcp_sign_ins (
			state_hash text primary key,
			user_id text not null references users (id) on delete cascade,
			connection_id text references mcp_connections (id) on delete cascade,
			secret text not null,
			expires_at timestamptz not null
		)`;
	await sql`delete from mcp_sign_ins where expires_at < now()`;
}

type Row = {
	id: string;
	user_id: string;
	name: string;
	slug: string;
	url: string;
	transport: Transport;
	auth: AuthKind;
	status: Status;
	enabled: boolean;
	credentials: string | null;
	header_names: string[];
	oauth_client_id: string | null;
	expires_at: Date | null;
	server_info: ServerInfo | null;
	tools: ToolInfo[];
	tools_checked_at: Date | null;
	tool_rules: Record<string, Rule>;
	last_error: string | null;
	last_used_at: Date | null;
	created_at: Date;
	updated_at: Date;
};

const fromRow = (row: Row): Connection => ({
	id: row.id,
	userId: row.user_id,
	name: row.name,
	slug: row.slug,
	url: row.url,
	transport: row.transport,
	auth: row.auth,
	status: row.status,
	enabled: row.enabled,
	headerNames: row.header_names,
	oauthClientId: row.oauth_client_id,
	expiresAt: row.expires_at,
	serverInfo: row.server_info,
	tools: row.tools,
	toolsCheckedAt: row.tools_checked_at,
	toolRules: row.tool_rules,
	lastError: row.last_error,
	lastUsedAt: row.last_used_at,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	sealed: row.credentials,
});

const credentialsContext = (id: string) => `mcp_connections:${id}:credentials`;

/** The connection's credentials. Throws UnreadableSecret when the key changed. */
export function readCredentials(connection: Pick<Connection, "id" | "sealed">): Credentials {
	return connection.sealed ? (JSON.parse(unseal(credentialsContext(connection.id), connection.sealed)) as Credentials) : {};
}

const sealCredentials = (id: string, credentials: Credentials) => seal(credentialsContext(id), JSON.stringify(credentials));

/** When the access token expires, from the tokens as saved. Null when the server did not say. */
export function tokenExpiry(credentials: Credentials) {
	const tokens = credentials.tokens as (OAuthTokens & { expires_at?: number }) | undefined;
	return tokens?.expires_at ? new Date(tokens.expires_at) : null;
}

export async function listConnections(userId: string): Promise<Connection[]> {
	const rows = await sql<Row[]>`select * from mcp_connections where user_id = ${userId} order by created_at`;
	return rows.map(fromRow);
}

/** The connections a reply knows of: every one that is on, whatever its status. */
export async function connectionsForReply(userId: string): Promise<Connection[]> {
	const rows = await sql<Row[]>`
		select * from mcp_connections where user_id = ${userId} and enabled order by slug`;
	return rows.map(fromRow);
}

/** The person's connections that are on but failed, last changed over `waitMs` ago: tried again in the background. */
export async function connectionsToRetry(userId: string, waitMs: number): Promise<Connection[]> {
	const rows = await sql<Row[]>`
		select * from mcp_connections where user_id = ${userId} and enabled and status = 'error'
			and updated_at < now() - make_interval(secs => ${waitMs / 1000})`;
	return rows.map(fromRow);
}

/** The person's connection, or undefined when it is not theirs. */
export async function getConnection(id: string, userId: string): Promise<Connection | undefined> {
	const [row] = await sql<Row[]>`select * from mcp_connections where id = ${id} and user_id = ${userId}`;
	return row && fromRow(row);
}

export async function takenSlugs(userId: string) {
	const rows = await sql<{ slug: string }[]>`select slug from mcp_connections where user_id = ${userId}`;
	return new Set(rows.map((row) => row.slug));
}

export async function hasConnectionTo(userId: string, url: string) {
	const [row] = await sql`select 1 from mcp_connections where user_id = ${userId} and url = ${url}`;
	return Boolean(row);
}

export type NewConnection = {
	userId: string;
	name: string;
	slug: string;
	url: string;
	transport: Transport;
	auth: AuthKind;
	oauthClientId: string | null;
	credentials: Credentials;
	serverInfo: ServerInfo | null;
	tools: ToolInfo[];
};

/** Saves a new connection. Undefined when the person already has one for this URL or slug. */
export async function insertConnection(input: NewConnection): Promise<Connection | undefined> {
	const id = randomUUID();
	const [row] = await sql<Row[]>`
		insert into mcp_connections (id, user_id, name, slug, url, transport, auth, credentials, header_names, oauth_client_id,
			expires_at, server_info, tools, tools_checked_at)
		values (${id}, ${input.userId}, ${input.name}, ${input.slug}, ${input.url}, ${input.transport}, ${input.auth},
			${sealCredentials(id, input.credentials)}, ${Object.keys(input.credentials.headers ?? {})}, ${input.oauthClientId},
			${tokenExpiry(input.credentials)}, ${input.serverInfo ? sql.json(input.serverInfo) : null}, ${sql.json(input.tools as never)}, now())
		on conflict do nothing
		returning *`;
	return row && fromRow(row);
}

/** New credentials, and with them the status: a sign-in that worked, a refresh, or tokens that were refused. */
export async function saveCredentials(id: string, credentials: Credentials, status?: { status: Status; lastError?: string | null }) {
	await sql`
		update mcp_connections set
			credentials = ${sealCredentials(id, credentials)},
			header_names = ${Object.keys(credentials.headers ?? {})},
			expires_at = ${tokenExpiry(credentials)},
			status = ${status?.status ?? sql`status`},
			last_error = ${status ? (status.lastError ?? null) : sql`last_error`},
			updated_at = now()
		where id = ${id}`;
}

export async function setStatus(id: string, status: Status, lastError: string | null = null) {
	await sql`update mcp_connections set status = ${status}, last_error = ${lastError}, updated_at = now() where id = ${id}`;
}

/** Records a failure and keeps the status: a connected server that did not answer once stays connected. */
export async function setLastError(id: string, lastError: string) {
	await sql`update mcp_connections set last_error = ${lastError} where id = ${id}`;
}

export async function saveTools(id: string, tools: ToolInfo[], serverInfo: ServerInfo | null) {
	await sql`
		update mcp_connections set tools = ${sql.json(tools as never)}, server_info = ${serverInfo ? sql.json(serverInfo) : null},
			tools_checked_at = now(), status = 'connected', last_error = null, updated_at = now()
		where id = ${id}`;
}

export async function markUsed(id: string) {
	await sql`update mcp_connections set last_used_at = now() where id = ${id}`;
}

export type ConnectionPatch = { name?: string; enabled?: boolean; toolRules?: Record<string, Rule> };

export async function updateConnection(id: string, userId: string, patch: ConnectionPatch): Promise<Connection | undefined> {
	const [row] = await sql<Row[]>`
		update mcp_connections set
			name = ${patch.name ?? sql`name`},
			enabled = ${patch.enabled ?? sql`enabled`},
			tool_rules = ${patch.toolRules ? sql.json(patch.toolRules) : sql`tool_rules`},
			updated_at = now()
		where id = ${id} and user_id = ${userId}
		returning *`;
	return row && fromRow(row);
}

export async function deleteConnection(id: string, userId: string) {
	const rows = await sql`delete from mcp_connections where id = ${id} and user_id = ${userId} returning id`;
	return rows.length > 0;
}

// OAuth sign-ins in progress.

export type SignInSecret = {
	verifier?: string;
	redirectUrl: string;
	credentials: Credentials;
	/** For a new connection: what the person entered. Absent when they sign in again to an existing one. */
	draft?: { name: string; url: string; transport: Transport; oauthClientId: string | null };
};

const SIGN_IN_MINUTES = 10;
export const hashState = (state: string) => createHash("sha256").update(state).digest("base64url");
const signInContext = (stateHash: string) => `mcp_sign_ins:${stateHash}`;

export async function saveSignIn(state: string, userId: string, connectionId: string | null, secret: SignInSecret) {
	const stateHash = hashState(state);
	await sql`delete from mcp_sign_ins where expires_at < now()`;
	await sql`
		insert into mcp_sign_ins (state_hash, user_id, connection_id, secret, expires_at)
		values (${stateHash}, ${userId}, ${connectionId}, ${seal(signInContext(stateHash), JSON.stringify(secret))},
			now() + make_interval(mins => ${SIGN_IN_MINUTES}))`;
}

/** Takes the sign-in out, so its state works once. Undefined when it is unknown, expired, or someone else's. */
export async function takeSignIn(state: string, userId: string): Promise<{ connectionId: string | null; secret: SignInSecret } | undefined> {
	const stateHash = hashState(state);
	const [row] = await sql<{ connection_id: string | null; secret: string; expires_at: Date }[]>`
		delete from mcp_sign_ins where state_hash = ${stateHash} and user_id = ${userId} returning connection_id, secret, expires_at`;
	if (!row || row.expires_at.getTime() < Date.now()) return undefined;
	try {
		return { connectionId: row.connection_id, secret: JSON.parse(unseal(signInContext(stateHash), row.secret)) as SignInSecret };
	} catch (error) {
		if (error instanceof UnreadableSecret) return undefined;
		throw error;
	}
}
