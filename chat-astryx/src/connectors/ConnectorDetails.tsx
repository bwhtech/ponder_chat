import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { DocumentDuplicateIcon } from "@heroicons/react/24/outline";
import { fullDate, when } from "../lib/dates";
import { toast } from "../lib/toast";
import type { Connector } from "./api";

/** A connector's server, sign-in and dates. */
export default function ConnectorDetails({ connector: c }: { connector: Connector }) {
	function copyUrl() {
		void navigator.clipboard?.writeText(c.url);
		toast("Copied the server URL");
	}

	return (
		<section className="flex flex-col gap-2 pt-2">
			<Heading level={3}>Details</Heading>
			<MetadataList label={{ width: 128 }}>
				<MetadataListItem label="Server URL">
					<span className="flex min-w-0 items-center gap-1">
						<span className="min-w-0 truncate font-mono text-xs" title={c.url}>
							{c.url}
						</span>
						<IconButton label="Copy the server URL" variant="ghost" size="sm" icon={<Icon icon={DocumentDuplicateIcon} />} onClick={copyUrl} />
					</span>
				</MetadataListItem>
				<MetadataListItem label="Sign-in">
					<Text type="body">{signIn(c)}</Text>
				</MetadataListItem>
				{c.serverName ? (
					<MetadataListItem label="Server">
						<Text type="body">{c.serverName}</Text>
					</MetadataListItem>
				) : null}
				<MetadataListItem label="Added">
					<Text type="body">{fullDate(c.createdAt)}</Text>
				</MetadataListItem>
				<MetadataListItem label="Last used">
					<Text type="body">{c.lastUsedAt ? when(c.lastUsedAt) : "Never"}</Text>
				</MetadataListItem>
			</MetadataList>
		</section>
	);
}

function signIn(c: Connector) {
	if (c.auth === "none") return "None. Anyone with the address can use this server.";
	if (c.auth === "headers") return `An API key in the ${c.headerNames.join(", ")} header. Saved encrypted; Ponder never shows it again.`;
	if (c.oauthClientId) return `OAuth, with your own app (client ID ${c.oauthClientId}).`;
	return `OAuth. Ponder registered itself with ${c.name}.`;
}
