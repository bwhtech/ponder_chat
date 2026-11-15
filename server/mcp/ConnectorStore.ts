import { createHash, randomUUID } from "node:crypto";
import type { OAuthAuthorizationServerInformation, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Secrets from "../secrets/Secrets.ts";
import type { AuthKind, ConnectorStatus as Status, Rule, Transport } from "../../shared/connectors.ts";

/**
 * Connectors: the MCP servers each person connected, in Postgres. Every query is here.
 *
 * - mcp_connections: one row for each server a person connected. The credentials (header
 *   values, OAuth client and tokens) are one sealed JSON value (secrets/Secrets.ts), bound to
 *   the row. What is not secret (status, expiry, tools, rules) is in plain columns.
 * - mcp_sign_ins: OAuth sign-ins in progress, for 10 minutes. Only a hash of the OAuth
 *   state is kept; the state itself is only in the URL.
 *
 * Deleting a person deletes their connections and sign-ins.
 *
 * Failures are the database's own (SqlError), and UnreadableSecret where credentials are
 * sealed or opened. A row or a sealed value that does not decode is a bug: a defect.
 */
export type { AuthKind, Rule, Status, Transport };

const TransportSchema = Schema.Literals(["http", "sse"]);
const AuthKindSchema = Schema.Literals(["none", "headers", "oauth"]);
const StatusSchema = Schema.Literals(["connected", "needs_sign_in", "error"]);
const RuleSchema = Schema.Literals(["allow", "ask", "off"]);

/** A tool as the server listed it, kept as plain data (tools.ts toToolInfo). */
const ToolInfoSchema = Schema.Struct({
	name: Schema.String,
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	inputSchema: Schema.Record(Schema.String, Schema.Unknown),
	readOnly: Schema.Boolean,
	destructive: Schema.Boolean,
});
export type ToolInfo = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
	destructive: boolean;
};

const ServerInfoSchema = Schema.Struct({
	name: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	version: Schema.optional(Schema.String),
	instructions: Schema.optional(Schema.String),
});
export type ServerInfo = { name?: string; title?: string; version?: string; instructions?: string };

/** The SDK's OAuth objects, as it gave them: only that each is an object is checked. The SDK owns their shape. */
const sdkObject = <T>() => Schema.declare((value): value is T => Predicate.isObject(value));

const CredentialsSchema = Schema.Struct({
	headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	client: Schema.optional(sdkObject<OAuthClientInformation>()),
	clientIsDynamic: Schema.optional(Schema.Boolean),
	authServer: Schema.optional(sdkObject<OAuthAuthorizationServerInformation>()),
	tokens: Schema.optional(sdkObject<OAuthTokens>()),
});
const CredentialsJson = Schema.fromJsonString(CredentialsSchema);

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

const Row = Schema.Struct({
	id: Schema.String,
	user_id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	url: Schema.String,
	transport: TransportSchema,
	auth: AuthKindSchema,
	status: StatusSchema,
	enabled: Schema.Boolean,
	credentials: Schema.NullOr(Schema.String),
	header_names: Schema.mutable(Schema.Array(Schema.String)),
	oauth_client_id: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.Date),
	server_info: Schema.NullOr(ServerInfoSchema),
	tools: Schema.mutable(Schema.Array(ToolInfoSchema)),
	tools_checked_at: Schema.NullOr(Schema.Date),
	tool_rules: Schema.Record(Schema.String, RuleSchema),
	last_error: Schema.NullOr(Schema.String),
	last_used_at: Schema.NullOr(Schema.Date),
	created_at: Schema.Date,
	updated_at: Schema.Date,
});

const fromRow = (row: typeof Row.Type): Connection => ({
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

export type ConnectionPatch = { name?: string; enabled?: boolean; toolRules?: Record<string, Rule> };

// OAuth sign-ins in progress.

const DraftSchema = Schema.Struct({ name: Schema.String, url: Schema.String, transport: TransportSchema, oauthClientId: Schema.NullOr(Schema.String) });
const SignInSecretJson = Schema.fromJsonString(
	Schema.Struct({
		verifier: Schema.optional(Schema.String),
		redirectUrl: Schema.String,
		credentials: CredentialsSchema,
		draft: Schema.optional(DraftSchema),
	}),
);

export type SignInSecret = {
	verifier?: string;
	redirectUrl: string;
	credentials: Credentials;
	/** For a new connection: what the person entered. Absent when they sign in again to an existing one. */
	draft?: { name: string; url: string; transport: Transport; oauthClientId: string | null };
};

export type SignIn = { connectionId: string | null; secret: SignInSecret };

const SignInRow = Schema.Struct({ connection_id: Schema.NullOr(Schema.String), secret: Schema.String, expires_at: Schema.Date });
const OfUser = Schema.Struct({ id: Schema.String, userId: Schema.String });

const SIGN_IN_MINUTES = 10;
export const hashState = (state: string) => createHash("sha256").update(state).digest("base64url");
const signInContext = (stateHash: string) => `mcp_sign_ins:${stateHash}`;
const credentialsContext = (id: string) => `mcp_connections:${id}:credentials`;

/** When the access token expires, from the tokens as saved. Null when the server did not say. */
export function tokenExpiry(credentials: Credentials) {
	const tokens = credentials.tokens as (OAuthTokens & { expires_at?: number }) | undefined;
	return tokens?.expires_at ? new Date(tokens.expires_at) : null;
}

export class ConnectorStore extends Context.Service<
	ConnectorStore,
	{
		/** Creates the two tables, and deletes the sign-ins that expired. Startup runs it. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The connection's credentials. Fails with UnreadableSecret when the key changed. */
		readonly readCredentials: (connection: Pick<Connection, "id" | "sealed">) => Effect.Effect<Credentials, Secrets.UnreadableSecret>;
		readonly listConnections: (userId: string) => Effect.Effect<Connection[], SqlError>;
		/** The connections a reply knows of: every one that is on, whatever its status. */
		readonly connectionsForReply: (userId: string) => Effect.Effect<Connection[], SqlError>;
		/** The person's connections that are on but failed, last changed over `waitMs` ago: tried again in the background. */
		readonly connectionsToRetry: (userId: string, waitMs: number) => Effect.Effect<Connection[], SqlError>;
		/** The person's connection, or none when it is not theirs. */
		readonly getConnection: (id: string, userId: string) => Effect.Effect<Option.Option<Connection>, SqlError>;
		readonly takenSlugs: (userId: string) => Effect.Effect<Set<string>, SqlError>;
		readonly hasConnectionTo: (userId: string, url: string) => Effect.Effect<boolean, SqlError>;
		/** Saves a new connection. None when the person already has one for this URL or slug. */
		readonly insertConnection: (input: NewConnection) => Effect.Effect<Option.Option<Connection>, SqlError | Secrets.UnreadableSecret>;
		/** New credentials, and with them the status: a sign-in that worked, a refresh, or tokens that were refused. */
		readonly saveCredentials: (
			id: string,
			credentials: Credentials,
			status?: { status: Status; lastError?: string | null },
		) => Effect.Effect<void, SqlError | Secrets.UnreadableSecret>;
		readonly setStatus: (id: string, status: Status, lastError?: string | null) => Effect.Effect<void, SqlError>;
		/** Records a failure and keeps the status: a connected server that did not answer once stays connected. */
		readonly setLastError: (id: string, lastError: string) => Effect.Effect<void, SqlError>;
		readonly saveTools: (id: string, tools: ToolInfo[], serverInfo: ServerInfo | null) => Effect.Effect<void, SqlError>;
		readonly markUsed: (id: string) => Effect.Effect<void, SqlError>;
		/** None when the connection is not the person's. */
		readonly updateConnection: (id: string, userId: string, patch: ConnectionPatch) => Effect.Effect<Option.Option<Connection>, SqlError>;
		/** False when the connection is not the person's. */
		readonly deleteConnection: (id: string, userId: string) => Effect.Effect<boolean, SqlError>;
		readonly saveSignIn: (state: string, userId: string, connectionId: string | null, secret: SignInSecret) => Effect.Effect<void, SqlError | Secrets.UnreadableSecret>;
		/** Takes the sign-in out, so its state works once. None when it is unknown, expired, or someone else's. */
		readonly takeSignIn: (state: string, userId: string) => Effect.Effect<Option.Option<SignIn>, SqlError>;
	}
>()("ponder/mcp/ConnectorStore") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const secrets = yield* Secrets.Secrets;

	const migrate = Effect.gen(function* () {
		yield* sql`
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
		yield* sql`
			create table if not exists mcp_sign_ins (
				state_hash text primary key,
				user_id text not null references users (id) on delete cascade,
				connection_id text references mcp_connections (id) on delete cascade,
				secret text not null,
				expires_at timestamptz not null
			)`;
		yield* sql`delete from mcp_sign_ins where expires_at < now()`;
	});

	const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson);
	const decodeSignInSecret = Schema.decodeUnknownEffect(SignInSecretJson);

	// Not traced: a connection's credentials are opened for each of its calls, and the work is a few microseconds.
	const readCredentials = Effect.fnUntraced(function* (connection: Pick<Connection, "id" | "sealed">) {
		const { sealed } = connection;
		if (!sealed) return {} as Credentials;
		const json = yield* secrets.unseal(credentialsContext(connection.id), sealed);
		return (yield* decodeCredentials(json).pipe(Effect.catchTags({ SchemaError: Effect.die }))) as Credentials;
	});

	const sealCredentials = (id: string, credentials: Credentials) => secrets.seal(credentialsContext(id), JSON.stringify(credentials));

	const findMany = (execute: (request: { userId: string }) => Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
		SqlSchema.findAll({ Request: Schema.Struct({ userId: Schema.String }), Result: Row, execute });

	const findAllOf = findMany(({ userId }) => sql`select * from mcp_connections where user_id = ${userId} order by created_at`);
	const findForReply = findMany(({ userId }) => sql`
		select * from mcp_connections where user_id = ${userId} and enabled order by slug`);
	const findToRetry = SqlSchema.findAll({
		Request: Schema.Struct({ userId: Schema.String, waitMs: Schema.Number }),
		Result: Row,
		execute: ({ userId, waitMs }) => sql`
			select * from mcp_connections where user_id = ${userId} and enabled and status = 'error'
				and updated_at < now() - make_interval(secs => ${waitMs / 1000})`,
	});
	const findOne = SqlSchema.findOneOption({
		Request: OfUser,
		Result: Row,
		execute: ({ id, userId }) => sql`select * from mcp_connections where id = ${id} and user_id = ${userId}`,
	});

	const rows = <E>(found: Effect.Effect<Array<typeof Row.Type>, E | Schema.SchemaError>) =>
		found.pipe(
			Effect.catchTags({ SchemaError: Effect.die }),
			Effect.map((list) => list.map(fromRow)),
		) as Effect.Effect<Connection[], Exclude<E, Schema.SchemaError>>;

	/** The first row of a statement that returns the connection's row, decoded. */
	const firstRow = (statement: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
		statement.pipe(
			Effect.flatMap((found) => (found.length ? Effect.map(Schema.decodeUnknownEffect(Row)(found[0]), (row) => Option.some(fromRow(row))) : Effect.succeed(Option.none<Connection>()))),
			Effect.catchTags({ SchemaError: Effect.die }),
		);

	const listConnections = Effect.fn("ConnectorStore.listConnections")(function* (userId: string) {
		return yield* rows(findAllOf({ userId }));
	});

	const connectionsForReply = Effect.fn("ConnectorStore.connectionsForReply")(function* (userId: string) {
		return yield* rows(findForReply({ userId }));
	});

	const connectionsToRetry = Effect.fn("ConnectorStore.connectionsToRetry")(function* (userId: string, waitMs: number) {
		return yield* rows(findToRetry({ userId, waitMs }));
	});

	const getConnection = Effect.fn("ConnectorStore.getConnection")(function* (id: string, userId: string) {
		const row = yield* findOne({ id, userId }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, fromRow);
	});

	const takenSlugs = Effect.fn("ConnectorStore.takenSlugs")(function* (userId: string) {
		const found = yield* sql<{ slug: string }>`select slug from mcp_connections where user_id = ${userId}`;
		return new Set(found.map((row) => row.slug));
	});

	const hasConnectionTo = Effect.fn("ConnectorStore.hasConnectionTo")(function* (userId: string, url: string) {
		const found = yield* sql`select 1 from mcp_connections where user_id = ${userId} and url = ${url}`;
		return found.length > 0;
	});

	const insertConnection = Effect.fn("ConnectorStore.insertConnection")(function* (input: NewConnection) {
		const id = randomUUID();
		const sealed = yield* sealCredentials(id, input.credentials);
		return yield* firstRow(sql`
			insert into mcp_connections (id, user_id, name, slug, url, transport, auth, credentials, header_names, oauth_client_id,
				expires_at, server_info, tools, tools_checked_at)
			values (${id}, ${input.userId}, ${input.name}, ${input.slug}, ${input.url}, ${input.transport}, ${input.auth},
				${sealed}, ${Object.keys(input.credentials.headers ?? {})}, ${input.oauthClientId},
				${tokenExpiry(input.credentials)}, ${input.serverInfo ? sql.json(input.serverInfo) : null}, ${sql.json(input.tools)}, now())
			on conflict do nothing
			returning *`);
	});

	const saveCredentials = Effect.fn("ConnectorStore.saveCredentials")(function* (
		id: string,
		credentials: Credentials,
		status?: { status: Status; lastError?: string | null },
	) {
		const sealed = yield* sealCredentials(id, credentials);
		yield* sql`
			update mcp_connections set
				credentials = ${sealed},
				header_names = ${Object.keys(credentials.headers ?? {})},
				expires_at = ${tokenExpiry(credentials)},
				status = ${status?.status ?? sql`status`},
				last_error = ${status ? (status.lastError ?? null) : sql`last_error`},
				updated_at = now()
			where id = ${id}`;
	});

	const setStatus = Effect.fn("ConnectorStore.setStatus")(function* (id: string, status: Status, lastError: string | null = null) {
		yield* sql`update mcp_connections set status = ${status}, last_error = ${lastError}, updated_at = now() where id = ${id}`;
	});

	const setLastError = Effect.fn("ConnectorStore.setLastError")(function* (id: string, lastError: string) {
		yield* sql`update mcp_connections set last_error = ${lastError} where id = ${id}`;
	});

	const saveTools = Effect.fn("ConnectorStore.saveTools")(function* (id: string, tools: ToolInfo[], serverInfo: ServerInfo | null) {
		yield* sql`
			update mcp_connections set tools = ${sql.json(tools)}, server_info = ${serverInfo ? sql.json(serverInfo) : null},
				tools_checked_at = now(), status = 'connected', last_error = null, updated_at = now()
			where id = ${id}`;
	});

	const markUsed = Effect.fn("ConnectorStore.markUsed")(function* (id: string) {
		yield* sql`update mcp_connections set last_used_at = now() where id = ${id}`;
	});

	const updateConnection = Effect.fn("ConnectorStore.updateConnection")(function* (id: string, userId: string, patch: ConnectionPatch) {
		return yield* firstRow(sql`
			update mcp_connections set
				name = ${patch.name ?? sql`name`},
				enabled = ${patch.enabled ?? sql`enabled`},
				tool_rules = ${patch.toolRules ? sql.json(patch.toolRules) : sql`tool_rules`},
				updated_at = now()
			where id = ${id} and user_id = ${userId}
			returning *`);
	});

	const deleteConnection = Effect.fn("ConnectorStore.deleteConnection")(function* (id: string, userId: string) {
		const deleted = yield* sql`delete from mcp_connections where id = ${id} and user_id = ${userId} returning id`;
		return deleted.length > 0;
	});

	const saveSignIn = Effect.fn("ConnectorStore.saveSignIn")(function* (state: string, userId: string, connectionId: string | null, secret: SignInSecret) {
		const stateHash = hashState(state);
		const sealed = yield* secrets.seal(signInContext(stateHash), JSON.stringify(secret));
		yield* sql`delete from mcp_sign_ins where expires_at < now()`;
		yield* sql`
			insert into mcp_sign_ins (state_hash, user_id, connection_id, secret, expires_at)
			values (${stateHash}, ${userId}, ${connectionId}, ${sealed},
				now() + make_interval(mins => ${SIGN_IN_MINUTES}))`;
	});

	const takeSignIn = Effect.fn("ConnectorStore.takeSignIn")(function* (state: string, userId: string) {
		const stateHash = hashState(state);
		const [found] = yield* sql`
			delete from mcp_sign_ins where state_hash = ${stateHash} and user_id = ${userId} returning connection_id, secret, expires_at`;
		if (!found) return Option.none<SignIn>();
		const row = yield* Schema.decodeUnknownEffect(SignInRow)(found).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		if (row.expires_at.getTime() < (yield* Clock.currentTimeMillis)) return Option.none<SignIn>();
		return yield* secrets.unseal(signInContext(stateHash), row.secret).pipe(
			Effect.flatMap((json) => decodeSignInSecret(json)),
			Effect.map((secret) => Option.some<SignIn>({ connectionId: row.connection_id, secret: secret as SignInSecret })),
			Effect.catchTags({ UnreadableSecret: () => Effect.succeed(Option.none<SignIn>()), SchemaError: Effect.die }),
		);
	});

	return ConnectorStore.of({
		migrate,
		readCredentials,
		listConnections,
		connectionsForReply,
		connectionsToRetry,
		getConnection,
		takenSlugs,
		hasConnectionTo,
		insertConnection,
		saveCredentials,
		setStatus,
		setLastError,
		saveTools,
		markUsed,
		updateConnection,
		deleteConnection,
		saveSignIn,
		takeSignIn,
	});
});

export const layer = Layer.effect(ConnectorStore, make);
