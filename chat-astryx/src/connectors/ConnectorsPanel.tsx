import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { List } from "@astryxdesign/core/List";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { ExclamationCircleIcon, PlusIcon, PuzzlePieceIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { useStore } from "../lib/store";
import { PanelHeading } from "../settings/panel";
import { showAddConnector } from "../settings/state";
import { connectors, connectorsError, loadConnectors } from "./api";
import ConnectorRow from "./ConnectorRow";

/** Settings, Connectors: the MCP servers the person connected, and Add connector. */
export default function ConnectorsPanel() {
	const list = useStore(connectors);
	const error = useStore(connectorsError);
	const retry = () => void loadConnectors().catch(() => undefined);
	const add = <Button label="Add connector" variant="primary" icon={<Icon icon={PlusIcon} />} onClick={showAddConnector} />;

	return (
		<div className="flex flex-col gap-4">
			<PanelHeading title="Connectors" description="Apps that Ponder can use for you." actions={list?.length && !error ? add : undefined} />

			{error ? (
				<EmptyState
					icon={<Icon icon={ExclamationCircleIcon} size="lg" color="error" />}
					title="The connectors could not load"
					description={error}
					actions={<Button label="Try again" variant="secondary" onClick={retry} />}
				/>
			) : !list ? (
				<div className="flex flex-col" aria-busy="true" aria-label="Loading connectors">
					{[112, 144, 96].map((width, index) => (
						<div key={width} className="flex items-center gap-3 py-3">
							<Skeleton width={36} height={36} index={index} />
							<div className="flex flex-1 flex-col gap-1.5">
								<Skeleton width={width} height={14} index={index} />
								<Skeleton width={208} height={12} index={index} />
							</div>
							<Skeleton width={40} height={24} index={index} />
						</div>
					))}
				</div>
			) : list.length ? (
				<>
					<List hasDividers edge="flush">
						{list.map((connector) => (
							<ConnectorRow key={connector.id} connector={connector} />
						))}
					</List>
					<div className="flex items-start gap-2">
						<span className="pt-0.5">
							<Icon icon={ShieldCheckIcon} size="sm" color="secondary" />
						</span>
						<Text type="supporting" color="secondary">
							Ponder asks you before it uses a tool that changes something. You can change this for each tool on the connector's page.
						</Text>
					</div>
				</>
			) : (
				<EmptyState
					icon={<Icon icon={PuzzlePieceIcon} size="lg" color="secondary" />}
					title="No connectors yet"
					description="Connect Linear, Notion, a Frappe site or any MCP server. Then Ponder can look things up and do things there for you."
					actions={add}
				/>
			)}
		</div>
	);
}
