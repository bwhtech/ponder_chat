import { List } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { Connector, ConnectorChange, Rule } from "./api";
import ToolRuleRow, { RULE_OPTIONS } from "./ToolRuleRow";

/** A connector's tools, each with its rule, a rule for all of them, and a search when there are many. */
export default function ConnectorTools({ connector: c, onSave }: { connector: Connector; onSave: (change: ConnectorChange) => void }) {
	const [query, setQuery] = useState("");
	const count = (rule: Rule) => c.tools.filter((tool) => tool.rule === rule).length;
	const words = query.trim().toLowerCase();
	const shown = words ? c.tools.filter((tool) => `${tool.title ?? ""} ${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(words)) : c.tools;
	// "Mixed" when the tools have different rules.
	const rules = new Set(c.tools.map((tool) => tool.rule));
	const allRule = rules.size === 1 ? [...rules][0] : undefined;

	return (
		<section className="flex flex-col gap-3 pt-2">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<Heading level={3}>Tools</Heading>
					<Text type="supporting" color="secondary">
						{count("allow")} always allowed · {count("ask")} ask first · {count("off")} off
					</Text>
				</div>
				{c.tools.length > 0 && (
					<div className="flex items-center gap-2">
						<span aria-hidden="true">
							<Text type="supporting">All tools</Text>
						</span>
						<Selector
							label="Rule for all tools"
							isLabelHidden
							size="sm"
							width={168}
							placeholder="Mixed"
							options={RULE_OPTIONS}
							value={allRule}
							onChange={(value) => onSave({ rules: Object.fromEntries(c.tools.map((tool) => [tool.name, value as Rule])) })}
						/>
					</div>
				)}
			</div>
			{c.tools.length > 8 && (
				<TextInput type="search" label="Search tools" isLabelHidden placeholder="Search tools" startIcon={MagnifyingGlassIcon} width="100%" value={query} onChange={setQuery} />
			)}
			{shown.length > 0 && (
				<List hasDividers edge="flush">
					{shown.map((tool) => (
						<ToolRuleRow key={tool.name} connector={c} tool={tool} />
					))}
				</List>
			)}
			{!c.tools.length ? (
				<p className="py-6 text-center">
					<Text type="supporting" color="secondary">
						This server lists no tools.
					</Text>
				</p>
			) : !shown.length ? (
				<p className="py-6 text-center">
					<Text type="supporting" color="secondary">
						No tools match “{query}”.
					</Text>
				</p>
			) : null}
			<Text type="supporting" color="secondary">
				“Read-only” is what {c.name} says about a tool. Ponder uses it only to choose where each tool starts, so check the rules of the tools you rely on.
			</Text>
		</section>
	);
}
