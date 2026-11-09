import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ArrowLeftIcon, ArrowPathIcon, ArrowRightEndOnRectangleIcon, KeyIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { when } from "../lib/dates";
import { toast, toastError } from "../lib/toast";
import { showConnector } from "../settings/state";
import { confirmRemove, signInAgain } from "./actions";
import { changeConnector, refreshConnector, type Connector, type ConnectorChange } from "./api";
import ConnectorAvatar from "./ConnectorAvatar";
import ConnectorDetails from "./ConnectorDetails";
import ConnectorTools from "./ConnectorTools";
import NewKeyForm from "./NewKeyForm";

/** One connector: on or off, its sign-in, a rule for each tool, and its details. */
export default function ConnectorPage({ connector: c }: { connector: Connector }) {
	const [refreshing, setRefreshing] = useState(false);
	// A new key: the server checks it before it is saved (NewKeyForm.tsx).
	const [changingKey, setChangingKey] = useState(false);

	async function refresh() {
		setRefreshing(true);
		try {
			const fresh = await refreshConnector(c.id);
			toast(`${fresh.name}: ${fresh.tools.length} tools`);
		} catch (error) {
			toastError(error instanceof Error ? error.message : "Could not list the tools.");
		} finally {
			setRefreshing(false);
		}
	}

	const status = c.status === "needs_sign_in" ? "Sign-in ended" : c.status === "error" ? "Not working" : c.auth === "oauth" ? "Signed in" : "Connected";
	const checked = c.toolsCheckedAt ? `Tools checked ${when(c.toolsCheckedAt)}` : "Tools never checked";

	return (
		<div className="flex flex-col gap-6">
			<div>
				<Button label="Connectors" variant="ghost" icon={<Icon icon={ArrowLeftIcon} />} onClick={() => showConnector(null)} />
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<ConnectorAvatar name={c.name} size="lg" />
				<div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
					<Heading level={2} maxLines={1}>
						{c.name}
					</Heading>
					<Text type="supporting" color="secondary">
						{c.host} · {status} · {checked}
					</Text>
				</div>
				<Switch label="Use in chats" value={c.enabled} isDisabled={c.status !== "connected"} onChange={(enabled) => void save(c, { enabled })} />
			</div>

			{c.status === "needs_sign_in" ? (
				<Banner
					status="warning"
					title="Sign in again"
					description={c.lastError ?? `${c.name} ended the sign-in.`}
					endContent={<Button label="Sign in" size="sm" variant="secondary" onClick={() => void signInAgain(c)} />}
				/>
			) : c.status === "error" ? (
				<Banner
					status="error"
					title={`${c.name} is not working`}
					description={c.lastError ?? ""}
					endContent={
						c.auth === "headers" ? (
							<Button label="Enter a new key" size="sm" variant="secondary" onClick={() => setChangingKey(true)} />
						) : (
							<Button label="Try again" size="sm" variant="secondary" isLoading={refreshing} onClick={() => void refresh()} />
						)
					}
				/>
			) : null}

			<div className="flex flex-wrap gap-2">
				<Button label="Refresh tools" variant="secondary" icon={<Icon icon={ArrowPathIcon} />} isLoading={refreshing} onClick={() => void refresh()} />
				{c.auth === "oauth" && <Button label="Sign in again" variant="secondary" icon={<Icon icon={ArrowRightEndOnRectangleIcon} />} onClick={() => void signInAgain(c)} />}
				{c.auth === "headers" && <Button label="Change API key" variant="secondary" icon={<Icon icon={KeyIcon} />} onClick={() => setChangingKey(true)} />}
				<Button label="Remove" variant="destructive" icon={<Icon icon={TrashIcon} />} onClick={() => confirmRemove(c)} />
			</div>

			{changingKey && <NewKeyForm connector={c} onDone={() => setChangingKey(false)} />}

			<ConnectorTools connector={c} onSave={(change) => void save(c, change)} />
			<ConnectorDetails connector={c} />
		</div>
	);
}

async function save(c: Connector, change: ConnectorChange) {
	try {
		await changeConnector(c.id, change);
	} catch (error) {
		toastError(error instanceof Error ? error.message : "Not saved.");
	}
}
