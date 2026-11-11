import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { hostname } from "./sources";

/** The links used for a reply (`source-url` parts), as a closed line: "Used 3 sources". */
export default function SourceList({ sources }: { sources: { url: string; title?: string }[] }) {
	return (
		<Collapsible
			defaultIsOpen={false}
			chevronPosition="start"
			trigger={
				<Text type="supporting" color="secondary">
					Used {sources.length} {sources.length === 1 ? "source" : "sources"}
				</Text>
			}
			data-slot="sources"
		>
			<div className="flex flex-col gap-1">
				{sources.map((source) => (
					<Text key={source.url} type="supporting" maxLines={1}>
						<Link href={source.url} isExternalLink size="sm">
							{source.title || hostname(source.url)}
						</Link>
					</Text>
				))}
			</div>
		</Collapsible>
	);
}
