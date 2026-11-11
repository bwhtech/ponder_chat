import { Badge } from "@astryxdesign/core/Badge";
import { Icon } from "@astryxdesign/core/Icon";
import { ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { toastError } from "../lib/toast";
import { changeConnector, RULES, showRule, toolTitle, type Connector, type ConnectorTool, type Rule } from "./api";

// By "connector id/tool name", shared by the rows, as a search can remove a row and bring
// it back while its change is on its way: the newest change, and the rule the server has
// while changes are on their way (the rule before them, or the newest one saved).
const newestRule = new Map<string, number>();
const savedRule = new Map<string, { change: number; rule: Rule }>();
let ruleChanges = 0;

export const RULE_OPTIONS = RULES.map((rule) => ({ value: rule.value, label: rule.label, icon: <Icon icon={rule.icon} /> }));

/** One tool of a connector, and when Ponder may use it: always, after asking, or never. */
export default function ToolRuleRow({ connector, tool }: { connector: Connector; tool: ConnectorTool }) {
	async function save(value: Rule) {
		const key = `${connector.id}/${tool.name}`;
		const mine = ++ruleChanges;
		newestRule.set(key, mine);
		if (!savedRule.has(key)) savedRule.set(key, { change: 0, rule: tool.rule });
		// Shown at once; the server's answer replaces the connector (api.ts keeps only the newest answer).
		showRule(connector.id, tool.name, value);
		try {
			await changeConnector(connector.id, { rules: { [tool.name]: value } });
			const saved = savedRule.get(key);
			if (saved && mine > saved.change) savedRule.set(key, { change: mine, rule: value });
		} catch (error) {
			// Only the newest change goes back, to what the server has: a later change shows what the person chose last.
			const saved = savedRule.get(key);
			if (newestRule.get(key) === mine && saved) showRule(connector.id, tool.name, saved.rule);
			toastError(error instanceof Error ? error.message : "The rule was not saved.");
		} finally {
			if (newestRule.get(key) === mine) savedRule.delete(key);
		}
	}

	const title = toolTitle(tool);
	return (
		<ListItem
			align="start"
			label={
				<span className="flex min-w-0 items-center gap-2">
					<Text type="body" color={tool.rule === "off" ? "secondary" : "primary"} maxLines={1}>
						{title}
					</Text>
					{tool.readOnly && <Badge label="Read-only" />}
				</span>
			}
			description={
				tool.description ? (
					<Text type="supporting" color="secondary" maxLines={2}>
						{tool.description}
					</Text>
				) : undefined
			}
			endContent={
				<Selector
					label={`When Ponder uses ${title}`}
					isLabelHidden
					size="sm"
					width={168}
					options={RULE_OPTIONS}
					value={tool.rule}
					onChange={(value) => void save(value as Rule)}
				/>
			}
		/>
	);
}
