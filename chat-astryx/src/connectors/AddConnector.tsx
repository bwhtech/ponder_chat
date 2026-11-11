import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { showConnector } from "../settings/state";
import type { Connector } from "./api";
import AddConnectorForm from "./AddConnectorForm";
import ConnectorAvatar from "./ConnectorAvatar";
import { useAddConnector } from "./use-add-connector";

/**
 * Add connector, as a page of Settings, Connectors: the form, the wait for the sign-in
 * window, then what was connected. Leaving the page stops a sign-in that waits.
 */
export default function AddConnector() {
	const add = useAddConnector();
	const { step } = add;
	const back = () => showConnector(null);

	if (step.kind === "waiting")
		return (
			<Outcome name={step.name} mark={<Spinner size="sm" />} title={`Sign in to ${step.name} in the new window`}>
				<Text type="supporting" color="secondary">
					{step.name} shows what Ponder may do. Ponder keeps the sign-in encrypted, and you can remove it at any time.
				</Text>
				<Button label="Cancel" variant="ghost" onClick={add.cancelWaiting} />
			</Outcome>
		);

	if (step.kind === "done")
		return (
			<Outcome name={step.connector.name} mark={<Icon icon={CheckIcon} size="sm" color="success" />} title={`${step.connector.name} is connected`}>
				<Text type="supporting" color="secondary">
					{doneText(step.connector)}
				</Text>
				<div className="flex gap-2 pt-2">
					<Button label="Review tools" variant="secondary" onClick={() => showConnector(step.connector.id)} />
					<Button label="Done" variant="primary" onClick={back} />
				</div>
			</Outcome>
		);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<Button label="Connectors" variant="ghost" icon={<Icon icon={ArrowLeftIcon} />} onClick={back} />
			</div>
			<Heading level={2}>Add connector</Heading>
			<AddConnectorForm add={add} onCancel={back} />
		</div>
	);
}

/** The wait and the result: the connector's letter, a mark on its corner, and what happens now. */
function Outcome({ name, mark, title, children }: { name: string; mark: ReactNode; title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-3 py-10 text-center" aria-live="polite">
			<div className="relative">
				<ConnectorAvatar name={name} size="lg" />
				<span className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full bg-surface shadow-sm">{mark}</span>
			</div>
			<Heading level={2}>{title}</Heading>
			<div className="flex max-w-sm flex-col items-center gap-3">{children}</div>
		</div>
	);
}

function doneText(connector: Connector) {
	const tools = connector.tools;
	const ask = tools.filter((tool) => tool.rule === "ask").length;
	if (!tools.length) return "The server lists no tools yet. Refresh its tools later, on its page.";
	if (!ask) return `${tools.length} tools. They only read, so Ponder uses them without asking.`;
	return `${tools.length} tools. Ponder uses the ${tools.length - ask} that only read, and asks you before it uses the other ${ask}.`;
}
