import * as PgClient from "@effect/sql-pg/PgClient";
import type { UIMessage } from "ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { nameFromFirstMessage } from "../../shared/thread-name.ts";
import * as Tracing from "../tracing/Tracing.ts";

/**
 * The person's threads: their messages, title and owner, in the `threads` table. A thread
 * belongs to the person who started it, and every method that changes one takes the
 * owner, so it acts only on that person's thread.
 *
 * Failures are the database's own (SqlError): a caller that can't act on one lets it
 * reach its boundary (route, runStep), which answers or retries as before. A row that
 * does not decode is a bug, not a failure: a defect.
 */

/**
 * A thread in the person's list (GET /api/threads, the boot page). The web app reads this
 * type. `workspaceId` only for a chat in a workspace (workspaces/Workspaces.ts).
 */
export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number; workspaceId?: string };

/** A saved thread's version, for the cache of GET /api/threads/:id: when it was saved, and its workspace. */
export type ThreadVersion = { updatedAt: Date; workspaceId: string | null };

/** The AI SDK's messages, as the app saved them. Only that each is an object is checked, as before: the AI SDK owns their shape. */
const Messages = Schema.mutable(Schema.Array(Schema.declare((value): value is UIMessage => Predicate.isObject(value))));

const MessagesRow = Schema.Struct({ messages: Messages });
const VersionRow = Schema.Struct({ updated_at: Schema.Date, workspace_id: Schema.NullOr(Schema.String) });
const WorkspaceRow = Schema.Struct({ workspace_id: Schema.NullOr(Schema.String) });
const OwnerRow = Schema.Struct({ owner: Schema.String });
const SummaryRow = Schema.Struct({
	id: Schema.String,
	title: Schema.NullOr(Schema.String),
	updated_at: Schema.Date,
	messages: Schema.Number,
	first: Schema.NullOr(Schema.String),
	workspace_id: Schema.NullOr(Schema.String),
});
const ThreadOfOwner = Schema.Struct({ id: Schema.String, owner: Schema.String });

export class Threads extends Context.Service<
	Threads,
	{
		/** Creates and updates the table, its search column and its indexes. Startup runs it first. */
		readonly migrate: Effect.Effect<void, SqlError>;
		/** The thread's messages, or none for a thread not saved yet. Any owner's: callers check the owner first. */
		readonly load: (id: string) => Effect.Effect<UIMessage[], SqlError>;
		/** When the person's thread was last saved, and its workspace; none for one not saved yet (or not theirs). Its version for caching. */
		readonly version: (id: string, owner: string) => Effect.Effect<Option.Option<ThreadVersion>, SqlError>;
		/** Whose thread this is; none for a new one. */
		readonly owner: (id: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/** The workspace the thread is in; none for a thread in no workspace, or not saved yet. */
		readonly workspaceOf: (id: string) => Effect.Effect<Option.Option<string>, SqlError>;
		/**
		 * Saves the person's thread. Someone else's thread with the same id is left alone. The
		 * workspace is set only when the thread is first saved, and never changes after.
		 */
		readonly save: (id: string, owner: string, messages: UIMessage[], workspaceId?: string) => Effect.Effect<void, SqlError>;
		/** Saves a reply into the person's thread. False, and nothing saved, when the thread was deleted. */
		readonly update: (id: string, owner: string, messages: UIMessage[]) => Effect.Effect<boolean, SqlError>;
		/** A person's threads, newest first, at most 200. Untitled threads are named by their first message. */
		readonly list: (owner: string) => Effect.Effect<ThreadSummary[], SqlError>;
		/** Renames the person's thread; an empty title goes back to the first message. False when it is not theirs. */
		readonly rename: (id: string, owner: string, title: string) => Effect.Effect<boolean, SqlError>;
		/** Deletes the person's thread. False when it is not theirs. */
		readonly remove: (id: string, owner: string) => Effect.Effect<boolean, SqlError>;
	}
>()("ponder/threads/Threads") {}

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;

	/**
	 * Words of each thread for search (thread-search.ts): its title, and the text the person
	 * and Ponder wrote, not tool output or files. The "simple" dictionary does not stem, so it
	 * works the same in every language. The text is the JSON of the parts, with its escapes
	 * blanked and cut to 500,000 characters, so a huge thread can't overflow a tsvector.
	 */
	const migrateSearch = Effect.gen(function* () {
		yield* sql.unsafe(`
			alter table threads add column if not exists search tsvector generated always as (
				setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') ||
				setweight(to_tsvector('simple'::regconfig, left(regexp_replace(
					jsonb_path_query_array(messages, '$[*].parts[*] ? (@.type == "text").text')::text,
					'\\\\[nrtbf"\\\\/]|\\\\u[0-9a-fA-F]{4}', ' ', 'g'), 500000)), 'B')
			) stored`);
		yield* sql`create index if not exists threads_search on threads using gin (search)`;
	});

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists threads (
				id text primary key,
				messages jsonb not null default '[]',
				updated_at timestamptz not null default now()
			)`;
		// Threads belong to the person who started them; a title replaces the first message as the name.
		yield* sql`alter table threads add column if not exists owner text not null default 'default'`;
		yield* sql`alter table threads add column if not exists title text`;
		yield* sql`create index if not exists threads_owner_updated on threads (owner, updated_at desc)`;
		// The chat's workspace, set by its first message. Its foreign key is Workspaces.migrate's, which runs after.
		yield* sql`alter table threads add column if not exists workspace_id text`;
		yield* sql`create index if not exists threads_workspace on threads (workspace_id) where workspace_id is not null`;
		yield* migrateSearch;
	});

	const findMessages = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: MessagesRow,
		execute: (id) => sql`select messages from threads where id = ${id}`,
	});
	const findVersion = SqlSchema.findOneOption({
		Request: ThreadOfOwner,
		Result: VersionRow,
		execute: ({ id, owner }) => sql`select updated_at, workspace_id from threads where id = ${id} and owner = ${owner}`,
	});
	const findWorkspace = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: WorkspaceRow,
		execute: (id) => sql`select workspace_id from threads where id = ${id}`,
	});
	const findOwner = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: OwnerRow,
		execute: (id) => sql`select owner from threads where id = ${id}`,
	});
	const findSummaries = SqlSchema.findAll({
		Request: Schema.String,
		Result: SummaryRow,
		execute: (owner) => sql`
			select id, title, updated_at, jsonb_array_length(messages) as messages,
				jsonb_path_query_first(messages, '$[*] ? (@.role == "user").parts[*] ? (@.type == "text").text') #>> '{}' as first,
				workspace_id
			from threads where owner = ${owner}
			order by updated_at desc limit 200`,
	});

	// The span's name and attribute are the ones it had before Effect: tracing.spec.ts looks for them.
	const load = Effect.fn("thread.load")(function* (id: string) {
		const row = yield* findMessages(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		const messages = Option.match(row, { onNone: (): UIMessage[] => [], onSome: (found) => found.messages });
		yield* Tracing.annotate({ "ponder.messages": messages.length });
		return messages;
	});

	const version = Effect.fn("Threads.version")(function* (id: string, owner: string) {
		const row = yield* findVersion({ id, owner }).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found): ThreadVersion => ({ updatedAt: found.updated_at, workspaceId: found.workspace_id }));
	});

	const owner = Effect.fn("Threads.owner")(function* (id: string) {
		const row = yield* findOwner(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.owner);
	});

	const workspaceOf = Effect.fn("Threads.workspaceOf")(function* (id: string) {
		const row = yield* findWorkspace(id).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.flatMap(row, (found) => Option.fromNullishOr(found.workspace_id));
	});

	const save = Effect.fn("Threads.save")(function* (id: string, owner: string, messages: UIMessage[], workspaceId?: string) {
		// The update leaves workspace_id alone: a chat's workspace never changes.
		yield* sql`
			insert into threads (id, owner, messages, workspace_id) values (${id}, ${owner}, ${sql.json(messages)}, ${workspaceId ?? null})
			on conflict (id) do update set messages = excluded.messages, updated_at = now()
			where threads.owner = excluded.owner`;
	});

	const update = Effect.fn("Threads.update")(function* (id: string, owner: string, messages: UIMessage[]) {
		const rows = yield* sql`update threads set messages = ${sql.json(messages)}, updated_at = now() where id = ${id} and owner = ${owner} returning id`;
		return rows.length > 0;
	});

	const list = Effect.fn("Threads.list")(function* (owner: string) {
		const rows = yield* findSummaries(owner).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return rows.map(
			(row): ThreadSummary => ({
				id: row.id,
				title: row.title || nameFromFirstMessage(row.first),
				updatedAt: row.updated_at.toISOString(),
				messages: row.messages,
				...(row.workspace_id && { workspaceId: row.workspace_id }),
			}),
		);
	});

	const rename = Effect.fn("Threads.rename")(function* (id: string, owner: string, title: string) {
		const rows = yield* sql`update threads set title = ${title.trim() || null} where id = ${id} and owner = ${owner} returning id`;
		return rows.length > 0;
	});

	const remove = Effect.fn("Threads.remove")(function* (id: string, owner: string) {
		const rows = yield* sql`delete from threads where id = ${id} and owner = ${owner} returning id`;
		return rows.length > 0;
	});

	return Threads.of({ migrate, load, version, owner, workspaceOf, save, update, list, rename, remove });
});

export const layer = Layer.effect(Threads, make);
