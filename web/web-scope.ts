/**
 * Where a reply's answer comes from, as the message box's menu names it (WebTools.vue):
 * the label and icon of its button, and the menu's rows. One word for the workspace's
 * files everywhere: Sources, with the same icon as the reply's "Not in Sources" line.
 */
export type ScopeState = { web: boolean; research: boolean; inWorkspace?: boolean };

export const SOURCES_ICON = "lucide-file-search";

export function scopeLabel({ web, research, inWorkspace }: ScopeState) {
	if (research) return { label: "Deep research", icon: "lucide-telescope" };
	if (web) return { label: inWorkspace ? "Sources + web" : "Web", icon: "lucide-globe" };
	return { label: inWorkspace ? "Sources only" : "No web", icon: inWorkspace ? SOURCES_ICON : "lucide-globe-lock" };
}

/** The menu's rows: the chat's two choices, then deep research, which takes in both, for the message being written only. */
export function scopeRows(inWorkspace: boolean) {
	return {
		off: inWorkspace
			? { label: "Sources only", description: "Only what the workspace's files say", icon: SOURCES_ICON }
			: { label: "No web", description: "What the model already knows", icon: "lucide-globe-lock" },
		web: inWorkspace
			? { label: "Sources + web", description: "Sources first, then a web search", icon: "lucide-globe" }
			: { label: "Web", description: "Searches when facts may have changed", icon: "lucide-globe" },
		research: {
			label: "Deep research",
			description: inWorkspace ? "Sources and a deep web search · this message only · more credits" : "A deep web search · this message only · more credits",
			icon: "lucide-telescope",
		},
	};
}
