import { count } from "../numbers";

/** Who can change a workspace, and how many people use it: no state here, so a test can import them. store.ts hands them on. */
export function canEdit(workspace: { access: string }) {
	return workspace.access === "edit" || workspace.access === "owner";
}

export function people(total: number) {
	return `${count(total)} ${total === 1 ? "person" : "people"}`;
}
