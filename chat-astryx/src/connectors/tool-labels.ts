import { toolLabeler } from "../chat/tool-renderers";
import { toast } from "../lib/toast";
import { changeConnector, connectors, findTool, toolTitle } from "./api";

/**
 * Connector tools show in the chat as "Linear · Create issue". When one waits for
 * approval, "Always allow" saves its rule, then approves. The labeler is set again each
 * time the list changes, so the chat shows names that came in after it rendered.
 */
function label(name: string) {
	const found = findTool(name);
	if (!found) return undefined;
	const { connector, tool } = found;
	return {
		title: `${connector.name} · ${toolTitle(tool)}`,
		question: `Allow Ponder to use ${connector.name}: ${toolTitle(tool)}?`,
		alwaysAllow: async () => {
			await changeConnector(connector.id, { rules: { [tool.name]: "allow" } });
			toast(`Ponder now uses ${toolTitle(tool)} in ${connector.name} without asking. You can change this in Settings, Connectors.`);
		},
	};
}

export function registerToolLabels() {
	toolLabeler.set(() => (name: string) => label(name));
	return connectors.subscribe(() => toolLabeler.set(() => (name: string) => label(name)));
}
