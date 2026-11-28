# Ponder Chat: teams

Goal: an org admin makes teams, such as HR and TFSS, and puts people in them. A team admin manages the people in their team. When a person shares a workspace, they can add a whole team, not only one person at a time.

This file keeps the decisions, the data model, the access rules, the API and the plan for each ticket. The decisions come from a design interview on 28 November 2026.

## Status

Built on the integration branch `feat/teams` (pull request #89), one ticket at a time (see "Tickets"). Each ticket had a review by a second model, and the branch had a review for standards and for this spec. Changes from this plan that the build made:

- `TeamDetail` also has `canOrganise`, `canChangePeople` and `grantCount`. The admin shell reads the scope from `user.adminScope` on `/api/me`; `GET /api/admin/me` also exists.
- Removing an email on the Users page also cancels its team invites. The "added to a team" email also goes to a new team's first admin.
- Nobody renames an archived team. A team admin does not see an archived team at all.
- A join at first sign-in is logged as "add-team-member", by invite. Delete logs one event with counts.

## Words

| Word | Meaning |
| --- | --- |
| Org | The whole Ponder instance. There is one org. |
| Org admin | A person with `users.role = 'admin'`. Unchanged: an org admin can do everything that an admin can do now. |
| Team | A named group of people in the org, such as HR. A team has a name and an optional description. |
| Team member | A person in a team. The membership has a role: `member` or `admin`. |
| Team admin | A team member with the role `admin`. A team can have many team admins. |
| Team grant | A workspace's grant to a team, at Can ask or Can edit. Every member of the team gets that access. |
| Team invite | An email that a team admin or an org admin invited to a team, which has no account yet. The person joins the team at their first sign-in. |
| Archived team | A team that an org admin put away. It keeps its rows, but it gives no access and nobody can change it. |

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| Teams per person | A person can be in many teams. | HR people also work on cross-team projects. |
| Who makes teams | Only org admins make, rename, archive, restore and delete teams. When they make a team, they name its first team admin. | Teams are org structure. |
| Roles in a team | `member` or `admin`. A team can have many admins. | One admin is a single point of failure. |
| What a team admin does | Adds people (existing accounts or new emails), removes people, changes roles, and cancels the team's pending invites. | This is the "manage the team" job. |
| What a team admin does not do | A team admin gets no extra rights on any workspace. Their access to a workspace is their own grant, their teams' grants or General access, as for any member. Only org admins change credits. | Managing people is not the same as owning content. |
| Last admin | A team must keep at least one team admin. The server refuses when a team admin removes or demotes the last admin, also themselves. An org admin may do it. The team then has no team admin, and only org admins manage it. | A team with no manager must be a decision of an org admin. |
| Team grants are live | A workspace keeps a grant to the team, not a copy of its members. A person added to the team gets access at once. A person removed from the team loses it at once, unless they have a direct grant or another team's grant. | This is what "the whole team gets access" means. |
| Grant level | Can ask or Can edit, never owner. | Same as a person row. |
| Effective access | The highest of: the direct member grant, every grant of an active team that the person is in, and General access (and the admin rule of access.ts, unchanged). | One rule, in one pure function. |
| Who adds teams to a workspace | Everyone who can share it (`canShare`: edit or above). They can add any active team, change its level or remove it, as for a person row. | Same as people. |
| Who sees teams | Every signed-in person can find every active team by name in the share picker, and sees its member count. | People must be able to share with a team that they are not in. |
| Who sees who is in a team | The team's own members, its team admins and org admins. | A team's member list is not for everyone. |
| Invites by a team admin | A new email goes into `allowed_emails`, invited by the team admin, with the instance default daily credits, and into `team_invites` with the role that the team admin picked. At the first sign-in (magic link or Microsoft), the person becomes a member of the team. | The pilot is invite-only. Team admins must be able to bring in their own people. |
| An email that has an account | It is added to the team at once, with the role picked. No invite. | |
| Banned people | Cannot be added to a team, and cannot be invited. | |
| Cancel an invite | A team admin or an org admin cancels a pending team invite. When no other team invite holds the email and an org admin did not invite it directly, the email also comes out of `allowed_emails`. | Cancelling must not leave a way in. |
| Where team admins work | In `/admin`, with a scope: a team admin sees only a Teams page, with only the teams that they admin. Every other `/admin` API answers 403 to them. In the chat, a team admin sees the Admin link. | One Teams page serves both roles, filtered by the viewer. |
| Org admins in `/admin` | The full `/admin`, with all teams. | |
| My teams | A read-only Teams panel in the user's Settings, next to Account and Memory. It lists the person's active teams with their members. A team that the person admins has a Manage link to its `/admin` page. | People must see which teams they are in. |
| Archive | The normal way to remove a team. Undo with Restore. While archived: its grants give no access but are kept; nobody can change its members, roles or invites; it is not in the share picker or in Settings > Teams; the share dialog shows its grant greyed out as "HR (archived)", and the grant can still be removed there. Invites to an archived team still apply at first sign-in, so Restore brings everything back. | A wrong delete of a team removes access from many workspaces at once. |
| Delete | Only an org admin, and only for an archived team. It deletes the team, its members, its invites and its grants. | |
| Emails | A team invite sends the normal invite email, and the email names the team. A person with an account who is added to a team gets one short email: "You were added to HR as a member" (or "as a team admin") "by X". No email for a role change, a removal, or a team grant on a workspace. | |
| Activity log | Every team change goes to the admin activity log: create, rename or description change, archive, restore, delete, member added, member removed, role changed, invite, invite cancelled. A team grant on a workspace is logged when the workspace is open to everyone, as person shares are now. | Admins must see who changed access. |
| Team names | Unique, case-insensitive. 1 to 80 characters after trim. | Two teams called "HR" in the picker cannot be told apart. |

## Data model

All tables are made in a `migrate` effect (raw SQL, idempotent, as the other services do), run from `server/startup.ts` after Accounts, Invites and Workspaces. Ticket 1 makes all of them, so the later tickets do not change the same migration.

```sql
create table if not exists teams (
	id text primary key,
	name text not null,
	description text not null default '',
	created_by text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	archived_at timestamptz
);
create unique index if not exists teams_name on teams (lower(name));

create table if not exists team_members (
	team_id text not null references teams (id) on delete cascade,
	user_id text not null references users (id) on delete cascade,
	role text not null check (role in ('member', 'admin')),
	added_by text not null,
	added_at timestamptz not null default now(),
	primary key (team_id, user_id)
);
create index if not exists team_members_user on team_members (user_id);

-- An email with no account yet. Lowercase. It becomes a team_members row at the first sign-in.
create table if not exists team_invites (
	team_id text not null references teams (id) on delete cascade,
	email text not null,
	role text not null check (role in ('member', 'admin')),
	invited_by text not null,
	created_at timestamptz not null default now(),
	primary key (team_id, email)
);
create index if not exists team_invites_email on team_invites (email);

-- True when only team invites put the email in allowed_emails. An org admin's own invite sets it to false.
alter table allowed_emails add column if not exists team_only boolean not null default false;

create table if not exists workspace_teams (
	workspace_id text not null references workspaces (id) on delete cascade,
	team_id text not null references teams (id) on delete cascade,
	access text not null check (access in ('ask', 'edit')),
	added_by text not null,
	added_at timestamptz not null default now(),
	primary key (workspace_id, team_id)
);
create index if not exists workspace_teams_team on workspace_teams (team_id);
```

## Access

`server/workspaces/access.ts` stays the one place for the rule. `AccessFacts` gets a `team: MemberAccess | null` field: the highest grant on the workspace among the active teams (`archived_at is null`) that the person is a member of. In `accessFrom`, the person's own access is `highest(member, team)`. Everything after that is unchanged: the owner is owner, a private workspace gives the admin nothing, and a workspace open to everyone gives admins edit and others ask.

The list of a person's workspaces (`rows.ts`, `summaries`) also includes the workspaces that one of their active teams has a grant on. `WorkspaceSummary.memberCount` stays the count of people. `WorkspaceSummary` gets `teamCount`.

Who can manage a team (pure, in `server/teams/access.ts`):

| Action | Org admin | Team admin of this team | Member | Anyone else |
| --- | --- | --- | --- | --- |
| See the team's name and member count (active teams) | yes | yes | yes | yes |
| See the members and invites | yes | yes | yes (members only, no invites) | no |
| Add, remove, change role, invite, cancel invite | yes | yes, not while archived; not the last admin | no | no |
| Make, rename, archive, restore | yes | no | no | no |
| Delete | yes, archived only | no | no | no |

## API

Team management, under `/api/admin/teams` (`server/teams/routes.ts`). The `/api/admin` guard lets a team admin through for `/api/admin/teams*` and `/api/admin/me` only. The service checks the team admin's role for each team. Every other `/api/admin` route stays org-admin only.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/admin/me` | org admin, team admin | `{ scope: "org" \| "team" }`: what the admin shell shows. |
| `GET /api/admin/teams` | org admin: all, archived too. Team admin: active teams they admin. | `{ id, name, description, memberCount, adminCount, inviteCount, archived }[]` |
| `POST /api/admin/teams` | org admin | `{ name, description, adminUserId }`: makes the team with its first team admin. |
| `GET /api/admin/teams/:id` | org admin, its team admins | The team, its members (`id, name, email, role, addedAt`) and its invites (`email, role, invitedBy, createdAt`). |
| `PATCH /api/admin/teams/:id` | org admin | `{ name?, description? }` |
| `PUT /api/admin/teams/:id/members/:userId` | org admin, its team admins | `{ role }`: adds the person, or changes their role. |
| `DELETE /api/admin/teams/:id/members/:userId` | org admin, its team admins | Removes the person. |
| `POST /api/admin/teams/:id/invites` | org admin, its team admins | `{ email, role }`: adds the account with that email, or invites the email. Answers `{ added: true }` or `{ invited: true }`. |
| `DELETE /api/admin/teams/:id/invites/:email` | org admin, its team admins | Cancels the invite. |
| `POST /api/admin/teams/:id/archive`, `/restore` | org admin | |
| `DELETE /api/admin/teams/:id` | org admin | Archived teams only. |

For every signed-in person (`server/teams/routes.ts`, mounted at `/api/teams`):

| Route | What |
| --- | --- |
| `GET /api/teams?q=` | Active teams whose name matches, at most 20: `{ id, name, memberCount }`. |
| `GET /api/teams/mine` | The person's active teams: `{ id, name, description, role, members: { id, name, email, role }[] }`. |

Workspace team grants (`server/workspaces/routes.ts`):

| Route | What |
| --- | --- |
| `PUT /api/workspaces/:id/teams/:teamId` | `{ access }`: adds the team, or changes its level. Whoever can share. An archived team cannot be added, but its level can be changed. |
| `DELETE /api/workspaces/:id/teams/:teamId` | Removes the grant. Whoever can share. |

`WorkspaceDetail` gets `teams: { id, name, memberCount, access, archived }[] | null`, null for a person who cannot share, as for `members`.

Refusals are tagged errors (`TeamNotFound` answers 404, `TeamRefused` answers 403 with a message, `TeamNameTaken` answers 409), as Workspaces.ts does.

## UI

Load the `ponder-ui`, `mobile-native` and `animate` skills for every ticket with UI. Each page works on a phone (the admin shell has a phone layout) and in dark mode.

- `/admin/teams`: the list of teams (name, members, admins, pending invites, Archived badge). Org admins see "New team" and the archived teams. Team admins see only their teams.
- `/admin/teams/:id`: name and description (org admins edit them), the members with their role, the pending invites, "Add people" (a people search and an email field, with a role choice), and per row: change role, remove, cancel invite. Org admins see Archive or Restore, and Delete for an archived team.
- The admin shell for a team admin: only the Teams item in the navigation, and the Teams page as its first page. A direct link to another `/admin` page shows the existing NoAccess state.
- The chat's Admin link: also for team admins.
- `ShareDialog.vue` and `PeoplePicker.vue`: the picker finds teams and people. A team row shows a team icon, the name and "12 members". The share dialog lists team grants with people, with the same Can ask / Can edit / Remove menu. An archived grant is greyed out, says "HR (archived)", and has only Remove.
- Settings > Teams (`web/settings/TeamsPanel.vue`): the person's teams, each with its members. "Manage" for teams that the person admins. An empty state when the person is in no team.

## Emails

- Team invite: the existing invite email, with a line that names the team and the person who invited.
- Added to a team (an account that existed before): "You were added to HR as a member by Aisha." or "as a team admin". With a link to Ponder.
- Send emails after the change is committed. A failed email does not undo the change, and it is logged.

## Tickets

Each ticket is a vertical slice with unit tests (vitest, `@effect/vitest`, database tests with `TEST_DATABASE_URL`) and e2e tests (Playwright).

1. **Teams for org admins.** All the tables above. A `Teams` service (`server/teams/`) with the pure rules in `server/teams/access.ts`. Make, rename, list, get, add a member, change a role, remove a member, with the last-admin rule and the banned-person refusal. Activity events. `/admin/teams` and `/admin/teams/:id` for org admins: make a team, edit it, add people with a role, change roles, remove people.
2. **Team admins and invites.** Blocked by 1. The `/api/admin` guard and the admin shell scope for team admins (`/api/admin/me`, only the Teams navigation, NoAccess elsewhere). The Admin link in the chat for team admins. Team invites: `team_invites`, `allowed_emails.team_only`, the membership at first sign-in (both sign-in methods), cancel invite. The two emails.
3. **Team grants on workspaces.** Blocked by 1. `GET /api/teams?q=`, the `team` field in `AccessFacts` and `accessFrom`, the workspace list for team members, the workspace team routes, `WorkspaceDetail.teams`, activity events for workspaces open to everyone. Teams in `PeoplePicker.vue` and `ShareDialog.vue`, with the greyed-out archived grant (archived teams exist as rows from ticket 1; ticket 4 adds the action).
4. **My teams, archive, restore and delete.** Blocked by 2 and 3. `GET /api/teams/mine` and Settings > Teams. Archive, restore and delete in the service, the API and `/admin/teams/:id`. Archived teams refuse changes to members, roles and invites, and are hidden from the picker and from Settings > Teams.

## Risks

- The workspace list query gets one more join. Check it with `EXPLAIN` on a database with many workspaces. The indexes `team_members_user` and `workspace_teams_team` are for it.
- Many tests and fixtures build `AccessFacts` by hand. They need the new `team` field.
- The `/api/admin` guard is a security boundary. Test that a team admin gets 403 on every non-team admin route, and on another team's routes.
