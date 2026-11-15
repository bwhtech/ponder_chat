import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as PonderConfig from "../config.ts";

/**
 * Who may sign in. The pilot is invite-only: an email must be in `allowed_emails`
 * (scripts/invite.ts adds and removes them) or in CHAT_ALLOWED_EMAILS. CHAT_OPEN_SIGNUP=1
 * lets anyone in, for local development.
 *
 * A sign-in link is sent only to an allowed email, and a new account is created only for
 * one. The page says "check your email" either way, so it does not tell who is invited.
 */
export type Invite = { note?: string; invitedBy?: string | null; dailyCredits?: number | null };

const InviteRow = Schema.Struct({ email: Schema.String, note: Schema.String, created_at: Schema.Date });
const EmailRow = Schema.Struct({ email: Schema.String });
const LimitRow = Schema.Struct({ daily_credits: Schema.NullOr(Schema.Number) });
const CountRow = Schema.Struct({ count: Schema.Number });

export type InviteRow = typeof InviteRow.Type;

export class Invites extends Context.Service<
	Invites,
	{
		/** Creates and updates the `allowed_emails` table. */
		readonly migrate: Effect.Effect<void, SqlError>;
		readonly isAllowed: (email: string) => Effect.Effect<boolean, SqlError>;
		/** Invites an email, or updates the note of one invited before. */
		readonly allow: (email: string, invite?: Invite) => Effect.Effect<void, SqlError>;
		/** Sets the daily limit an invited person starts with; null for the default. False when the email was not invited. */
		readonly setInviteCredits: (email: string, credits: number | null) => Effect.Effect<boolean, SqlError>;
		/** The daily limit of the invite of this lowercase email; none when there is no such invite, null for the default. */
		readonly inviteCredits: (email: string) => Effect.Effect<Option.Option<number | null>, SqlError>;
		/**
		 * On a person's first sign-in (Auth.ts): the daily limit from their invite becomes
		 * their own limit. Later changes are made to the person, not the invite.
		 */
		readonly applyInvite: (user: { id: string; email: string }) => Effect.Effect<void, SqlError>;
		/** False when the email was not invited. */
		readonly disallow: (email: string) => Effect.Effect<boolean, SqlError>;
		/** Whether this lowercase email was invited. */
		readonly invited: (email: string) => Effect.Effect<boolean, SqlError>;
		/** Of these lowercase emails, those invited already or with an account. */
		readonly taken: (emails: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, SqlError>;
		/** Invites that have no account yet, for the sidebar's count. */
		readonly waiting: Effect.Effect<number, SqlError>;
		/** Every invite, oldest first. */
		readonly list: Effect.Effect<ReadonlyArray<InviteRow>, SqlError>;
	}
>()("ponder/people/Invites") {}

const normalize = (email: string) => email.trim().toLowerCase();

const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const config = yield* PonderConfig.PonderConfig;
	const fromEnv = new Set(config.allowedEmails);

	const migrate = Effect.gen(function* () {
		yield* sql`
			create table if not exists allowed_emails (
				email text primary key,
				note text not null default '',
				created_at timestamptz not null default now()
			)`;
		// Who invited them (a user id; null for scripts/invite.ts), and their own daily limit, if any.
		yield* sql`alter table allowed_emails add column if not exists invited_by text`;
		yield* sql`alter table allowed_emails add column if not exists daily_credits integer`;
	});

	const findLimit = SqlSchema.findOneOption({
		Request: Schema.String,
		Result: LimitRow,
		execute: (email) => sql`select daily_credits from allowed_emails where email = ${email}`,
	});
	const findTaken = SqlSchema.findAll({
		Request: Schema.Array(Schema.String),
		Result: EmailRow,
		execute: (emails) => sql`
			select email from allowed_emails where email in ${sql.in(emails)}
			union select lower(email) from users where lower(email) in ${sql.in(emails)}`,
	});
	const countWaiting = SqlSchema.findOne({
		Request: Schema.Void,
		Result: CountRow,
		execute: () => sql`
			select count(*)::int as count from allowed_emails a where not exists (select 1 from users u where lower(u.email) = a.email)`,
	});
	const findAll = SqlSchema.findAll({
		Request: Schema.Void,
		Result: InviteRow,
		execute: () => sql`select email, note, created_at from allowed_emails order by created_at`,
	});

	const invited = Effect.fn("Invites.invited")(function* (email: string) {
		const rows = yield* sql`select 1 from allowed_emails where email = ${email}`;
		return rows.length > 0;
	});

	const isAllowed = Effect.fn("Invites.isAllowed")(function* (email: string) {
		const normalized = normalize(email);
		if (config.openSignup || fromEnv.has(normalized)) return true;
		return yield* invited(normalized);
	});

	const allow = Effect.fn("Invites.allow")(function* (email: string, { note = "", invitedBy = null, dailyCredits = null }: Invite = {}) {
		yield* sql`
			insert into allowed_emails (email, note, invited_by, daily_credits)
			values (${normalize(email)}, ${note}, ${invitedBy}, ${dailyCredits})
			on conflict (email) do update set note = excluded.note`;
	});

	const setInviteCredits = Effect.fn("Invites.setInviteCredits")(function* (email: string, credits: number | null) {
		const rows = yield* sql`update allowed_emails set daily_credits = ${credits} where email = ${normalize(email)} returning email`;
		return rows.length > 0;
	});

	const inviteCredits = Effect.fn("Invites.inviteCredits")(function* (email: string) {
		const row = yield* findLimit(email).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return Option.map(row, (found) => found.daily_credits);
	});

	const applyInvite = Effect.fn("Invites.applyInvite")(function* (user: { id: string; email: string }) {
		yield* sql`
			insert into credit_limits (user_id, daily_credits)
			select ${user.id}, daily_credits from allowed_emails
			where email = ${normalize(user.email)} and daily_credits is not null
			on conflict (user_id) do nothing`;
	});

	const disallow = Effect.fn("Invites.disallow")(function* (email: string) {
		const rows = yield* sql`delete from allowed_emails where email = ${normalize(email)} returning email`;
		return rows.length > 0;
	});

	const taken = Effect.fn("Invites.taken")(function* (emails: ReadonlyArray<string>) {
		if (!emails.length) return [];
		const rows = yield* findTaken(emails).pipe(Effect.catchTags({ SchemaError: Effect.die }));
		return rows.map((row) => row.email);
	});

	const waiting = countWaiting(undefined).pipe(
		Effect.map((row) => row.count),
		Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die }),
		Effect.withSpan("Invites.waiting"),
	);

	const list = findAll(undefined).pipe(Effect.catchTags({ SchemaError: Effect.die }), Effect.withSpan("Invites.list"));

	return Invites.of({ migrate, isAllowed, allow, setInviteCredits, inviteCredits, applyInvite, disallow, invited, taken, waiting, list });
});

export const layer = Layer.effect(Invites, make);
