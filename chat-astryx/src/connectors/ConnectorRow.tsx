import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { ListItem } from "@astryxdesign/core/List";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Switch } from "@astryxdesign/core/Switch";
import { ArrowPathIcon, ArrowRightEndOnRectangleIcon, Cog6ToothIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useRef } from "react";
import { toast, toastError } from "../lib/toast";
import { showConnector } from "../settings/state";
import { confirmRemove, signInAgain } from "./actions";
import { changeConnector, refreshConnector, type Connector } from "./api";
import ConnectorAvatar from "./ConnectorAvatar";

/** One connector in the list: its state, on or off, and its actions. The row opens its page. */
export default function ConnectorRow({ connector: c }: { connector: Connector }) {
	const opener = useRef<HTMLButtonElement>(null);
	const open = () => showConnector(c.id);
	const meta = describe(c);

	async function setEnabled(value: boolean) {
		try {
			await changeConnector(c.id, { enabled: value });
		} catch (error) {
			toastError(error instanceof Error ? error.message : "Not saved.");
		}
	}

	async function refresh() {
		try {
			const fresh = await refreshConnector(c.id);
			toast(`${fresh.name}: ${fresh.tools.length} tools`);
		} catch (error) {
			toastError(error instanceof Error ? error.message : "Could not list the tools.");
		}
	}

	return (
		<ListItem
			interactiveRef={opener}
			startContent={<ConnectorAvatar name={c.name} />}
			label={
				<button ref={opener} type="button" className="max-w-full truncate text-start font-medium" aria-label={`Open ${c.name}`} onClick={open}>
					{c.name}
				</button>
			}
			description={
				<span className={`block truncate ${meta.tone}`} title={meta.text}>
					{meta.text}
				</span>
			}
			endContent={
				<div className="flex items-center gap-1.5">
					{c.status === "needs_sign_in" ? (
						<Button label="Sign in again" size="sm" variant="secondary" onClick={() => void signInAgain(c)} />
					) : c.status === "error" ? (
						<Button label="Fix" size="sm" variant="secondary" onClick={open} />
					) : (
						<Switch label={`Use ${c.name} in chats`} isLabelHidden value={c.enabled} onChange={(value) => void setEnabled(value)} />
					)}
					<MoreMenu
						label={`Actions for ${c.name}`}
						alignment="end"
						items={[
							{ label: "Open", icon: <Icon icon={Cog6ToothIcon} />, onClick: open },
							{ label: "Refresh tools", icon: <Icon icon={ArrowPathIcon} />, onClick: () => void refresh() },
							...(c.auth === "oauth" ? [{ label: "Sign in again", icon: <Icon icon={ArrowRightEndOnRectangleIcon} />, onClick: () => void signInAgain(c) }] : []),
							{ label: "Remove", icon: <Icon icon={TrashIcon} />, variant: "destructive" as const, onClick: () => confirmRemove(c) },
						]}
					/>
				</div>
			}
		/>
	);
}

/** The line under the name: what needs doing, or the server and its tools. */
function describe(c: Connector) {
	if (c.status === "needs_sign_in") return { text: `Sign-in ended · ${c.host}`, tone: "text-warning" };
	if (c.status === "error") return { text: `${c.lastError ?? "Not working"} · ${c.host}`, tone: "text-error" };
	if (!c.enabled) return { text: `Off · ${c.host}`, tone: "text-secondary" };
	const on = c.tools.filter((tool) => tool.rule !== "off").length;
	return { text: `${c.host} · ${on} of ${c.tools.length} tools on`, tone: "text-secondary" };
}
