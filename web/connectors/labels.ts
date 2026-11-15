import { toast } from "../toasts";
import { getToolIcon, type ToolLabel, type ToolLabeler } from "frappe-ui-ai-elements";
import { CONNECTOR_CALL, CONNECTOR_SEARCH } from "../../shared/connectors";
import { changeConnector, findTool, toolTitle } from "./api";

/**
 * Connector steps in a reply. The model finds connector tools with connector_search and
 * calls them with connector_call({ tool, input }) (server/workflow/connectors.ts), so a
 * call is named after the tool it runs: "Linear · Create issue". Its approval card asks
 * about that tool and shows that tool's input, and "Always allow" saves that tool's rule.
 * Replies written before connector_call called each tool by its own name, such as
 * linear__create_issue; those are named the same way.
 */
type Part = Parameters<ToolLabeler>[1];

export function connectorLabel(name: string, part: Part): ToolLabel | undefined {
	if (name === CONNECTOR_SEARCH) return searchLabel(part);
	if (name === CONNECTOR_CALL) {
		const input = part?.input as { tool?: unknown; input?: unknown } | undefined;
		const label = typeof input?.tool === "string" ? toolLabel(input.tool) : undefined;
		// While the call streams in, the tool's name may not be whole yet.
		return label ? { ...label, input: input?.input ?? {} } : { title: "Using a connector" };
	}
	return toolLabel(name);
}

function searchLabel(part: Part): ToolLabel {
	const query = (part?.input as { query?: unknown } | undefined)?.query;
	const running = part?.state === "input-streaming" || part?.state === "input-available";
	const verb = running ? "Searching" : "Searched";
	return {
		title: typeof query === "string" && query.trim() ? `${verb} connectors for “${query.trim()}”` : `${verb} connectors`,
		action: "read",
		icon: "lucide-search",
	};
}

function toolLabel(modelName: string): ToolLabel | undefined {
	const found = findTool(modelName);
	if (!found) return undefined;
	const { connector, tool } = found;
	return {
		title: `${connector.name} · ${toolTitle(tool)}`,
		question: `Allow Ponder to use ${connector.name}: ${toolTitle(tool)}?`,
		action: tool.readOnly ? "read" : "write",
		// The icon a step of its own got from its name: a plus for add_note, a page for find_order.
		icon: getToolIcon(tool.name),
		alwaysAllow: async () => {
			await changeConnector(connector.id, { rules: { [tool.name]: "allow" } });
			toast.success(`Ponder now uses ${toolTitle(tool)} in ${connector.name} without asking. You can change this in Settings, Connectors.`);
		},
	};
}
