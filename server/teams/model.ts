import * as Schema from "effect/Schema";
import type { TeamRole } from "./access.ts";

/** What the Teams service (Teams.ts) takes and answers, and how it refuses. */
export type { TeamRole } from "./access.ts";

/**
 * Who asks for a change: their id, their email for the activity log, and the address they
 * use Ponder at, for the links in the emails a change sends.
 */
export type Actor = { id: string; email: string; origin: string };

/** What the admin shell shows (GET /api/admin/me): all of /admin, or only the teams the person admins. */
export type AdminScope = "org" | "team";

/** A row of /admin/teams. */
export type TeamSummary = {
	id: string;
	name: string;
	description: string;
	memberCount: number;
	adminCount: number;
	/** Pending invites: emails with no account yet. */
	inviteCount: number;
	archived: boolean;
};

export type TeamMember = { id: string; name: string; email: string; role: TeamRole; addedAt: string };
export type TeamInvite = { email: string; role: TeamRole; invitedBy: string; createdAt: string };

/** One team (/admin/teams/:id), as an org admin or one of its team admins sees it. */
export type TeamDetail = {
	id: string;
	name: string;
	description: string;
	archived: boolean;
	createdAt: string;
	members: TeamMember[];
	invites: TeamInvite[];
	/** Renames it, and archives, restores or deletes it: org admins. */
	canOrganise: boolean;
	/** Adds and removes people and changes their roles. */
	canChangePeople: boolean;
};

export type NewTeam = { name: string; description: string; adminUserId: string };
export type TeamChanges = { name?: string; description?: string };

/**
 * An invite by email: the account with that email joined, or the email was invited. The team
 * as the person sees it now: null when they invited their own email as a member.
 */
export type InviteResult = ({ added: true } | { invited: true }) & { team: TeamDetail | null };

/** No such team. Routes answer 404. */
export class TeamNotFound extends Schema.TaggedError<TeamNotFound>()("TeamNotFound", {
	teamId: Schema.String,
}) {
	override get message() {
		return "This team was not found.";
	}
}

const REFUSALS = {
	"needs-org-admin": "Only org admins can do this.",
	"needs-team-admin": "Only this team's admins and org admins can do this.",
	archived: "This team is archived. Restore it to change it.",
	"last-admin": "A team needs at least one team admin. Make someone else a team admin first.",
	banned: "This person is banned, so they can't join a team.",
	"no-account": "That person has no account.",
} as const;

/** The person may not do this to the team. Routes answer 403 with the message ("no-account": 400). */
export class TeamRefused extends Schema.TaggedError<TeamRefused>()("TeamRefused", {
	reason: Schema.Literals(["needs-org-admin", "needs-team-admin", "archived", "last-admin", "banned", "no-account"]),
}) {
	override get message() {
		return REFUSALS[this.reason];
	}
}

/** Another team has this name, in any case. Routes answer 409. */
export class TeamNameTaken extends Schema.TaggedError<TeamNameTaken>()("TeamNameTaken", {}) {
	override get message() {
		return "A team with this name already exists.";
	}
}
