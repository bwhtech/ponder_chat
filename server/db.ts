import postgres from "postgres";
import type { UIMessage } from "ai";

// Notices are "already exists, skipping" from the migrations.
export const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

export async function migrate() {
	await sql`
		create table if not exists threads (
			id text primary key,
			messages jsonb not null default '[]',
			updated_at timestamptz not null default now()
		)`;
	// Threads belong to the person who started them; a title replaces the first message as the name.
	await sql`alter table threads add column if not exists owner text not null default 'default'`;
	await sql`alter table threads add column if not exists title text`;
	await sql`create index if not exists threads_owner_updated on threads (owner, updated_at desc)`;
}

export async function loadThread(id: string): Promise<UIMessage[]> {
	const [row] = await sql`select messages from threads where id = ${id}`;
	return row?.messages ?? [];
}

/** When the person's thread was last saved, or null for one not saved yet (or not theirs). Its version for caching. */
export async function threadUpdatedAt(id: string, owner: string): Promise<Date | null> {
	const [row] = await sql<{ updated_at: Date }[]>`select updated_at from threads where id = ${id} and owner = ${owner}`;
	return row?.updated_at ?? null;
}

/** Whose thread this is, or undefined for a new one. */
export async function threadOwner(id: string): Promise<string | undefined> {
	const [row] = await sql<{ owner: string }[]>`select owner from threads where id = ${id}`;
	return row?.owner;
}

/** Saves the person's thread. Someone else's thread with the same id is left alone. */
export async function saveThread(id: string, owner: string, messages: UIMessage[]) {
	await sql`
		insert into threads (id, owner, messages) values (${id}, ${owner}, ${sql.json(messages as never)})
		on conflict (id) do update set messages = excluded.messages, updated_at = now()
		where threads.owner = excluded.owner`;
}

export type ThreadSummary = { id: string; title: string; updatedAt: string; messages: number };

/** A person's threads, newest first. Untitled threads are named by their first message. */
export async function listThreads(owner: string): Promise<ThreadSummary[]> {
	const rows = await sql<{ id: string; title: string | null; first: string | null; updated_at: Date; messages: number }[]>`
		select id, title, updated_at, jsonb_array_length(messages) as messages,
			jsonb_path_query_first(messages, '$[*] ? (@.role == "user").parts[*] ? (@.type == "text").text') #>> '{}' as first
		from threads where owner = ${owner}
		order by updated_at desc limit 200`;
	return rows.map((row) => ({
		id: row.id,
		title: row.title || nameFrom(row.first),
		updatedAt: row.updated_at.toISOString(),
		messages: row.messages,
	}));
}

export async function renameThread(id: string, owner: string, title: string) {
	const rows = await sql`update threads set title = ${title.trim() || null} where id = ${id} and owner = ${owner} returning id`;
	return rows.length > 0;
}

export async function deleteThread(id: string, owner: string) {
	const rows = await sql`delete from threads where id = ${id} and owner = ${owner} returning id`;
	return rows.length > 0;
}

/** The first line of the first message, cut at a word near 60 characters. */
function nameFrom(text: string | null) {
	const line = (text ?? "").split("\n")[0].trim();
	if (!line) return "New chat";
	if (line.length <= 60) return line;
	const cut = line.slice(0, 60);
	return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}
