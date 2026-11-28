/**
 * A team role in a sentence, such as "Added Ana as a team admin". /admin's pages, its
 * activity log and the "added to a team" email use this one function, so the words match.
 */
export function teamRoleName(role: unknown) {
	return role === "admin" ? "a team admin" : "a member";
}
