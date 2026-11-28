import { dialog, toast } from "frappe-ui";
import { plural } from "../../numbers";
import { admin, unwrap, type TeamDetail } from "../api";

/**
 * Archive, restore and delete a team (server/teams/lifecycle.ts), for org admins on the team
 * page. Archive and Delete ask first. `shown` gets the team as the change left it; `deleted`
 * runs once the team is gone.
 */
type Handlers = { shown: (team: TeamDetail) => void; deleted: () => void };

/** A menu item on a phone, a button on a wider screen. */
export type TeamAction = { label: string; icon: string; theme?: "red"; onClick: () => void };

export function teamActions(team: TeamDetail, handlers: Handlers): TeamAction[] {
	if (!team.canOrganise) return [];
	if (!team.archived) return [{ label: "Archive team", icon: "lucide-archive", onClick: () => archive(team, handlers) }];
	return [
		{ label: "Restore team", icon: "lucide-archive-restore", onClick: () => void restore(team, handlers) },
		{ label: "Delete team", icon: "lucide-trash-2", theme: "red", onClick: () => remove(team, handlers) },
	];
}

const byId = (team: TeamDetail) => ({ param: { id: encodeURIComponent(team.id) } });

function archive(team: TeamDetail, handlers: Handlers) {
	const grants = team.grantCount ? `Its ${plural(team.grantCount, "workspace grant")} stop giving access, but stay. ` : "";
	dialog.confirm({
		title: `Archive ${team.name}?`,
		message: `${grants}No one can change its people or invites, and it leaves the share picker and people's Settings. Restore brings it all back.`,
		confirmLabel: "Archive",
		onConfirm: async () => {
			handlers.shown((await unwrap(admin.teams[":id"].archive.$post(byId(team)))).team);
			toast.success(`Archived ${team.name}`);
		},
	});
}

async function restore(team: TeamDetail, handlers: Handlers) {
	try {
		handlers.shown((await unwrap(admin.teams[":id"].restore.$post(byId(team)))).team);
		toast.success(`Restored ${team.name}`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

function remove(team: TeamDetail, handlers: Handlers) {
	const goes = [plural(team.members.length, "member"), plural(team.grantCount, "workspace grant"), plural(team.invites.length, "invite")];
	const invites = team.invites.length ? " Emails that only this team invited can no longer sign in." : "";
	dialog.danger({
		title: `Delete ${team.name}?`,
		message: `This deletes the team with its ${goes[0]}, ${goes[1]} and ${goes[2]}.${invites} You can't undo this.`,
		confirmLabel: "Delete team",
		onConfirm: async () => {
			await unwrap(admin.teams[":id"].$delete(byId(team)));
			toast.success(`Deleted ${team.name}`);
			handlers.deleted();
		},
	});
}
