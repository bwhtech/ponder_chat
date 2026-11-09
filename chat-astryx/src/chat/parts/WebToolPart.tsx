import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import type { ToolRendererProps } from "../tool-renderers";
import { hostname } from "./sources";
import { toolPhase } from "./tool-state";

/**
 * A web_search or web_fetch call (server/search/tool.ts) as one line in the steps: what was
 * searched or read, and the pages it found, folded below.
 */
type Output = { results?: { title: string; url: string }[]; url?: string; title?: string; error?: string };

export default function WebToolPart({ part, name }: ToolRendererProps) {
	const output = outputOf(part);
	return (
		<div className="flex flex-col gap-1" data-slot="web-tool">
			{pages(name, output).map((page) => (
				<Text key={page.url} type="supporting" maxLines={1}>
					<Link href={page.url} isExternalLink size="sm">
						{page.title || hostname(page.url)}
					</Link>
				</Text>
			))}
			{output?.error && (
				<Text type="supporting" color="secondary">
					{output.error}
				</Text>
			)}
		</div>
	);
}

/** "Searching “query”", "Read example.com", "Could not search “query”". */
export function webToolLine({ part, name, streaming }: ToolRendererProps) {
	const search = name === "web_search";
	const input = ((part as { input?: unknown }).input ?? {}) as { query?: string; url?: string };
	const output = outputOf(part);
	const target = search ? `“${input.query ?? ""}”` : hostname(output?.url ?? input.url ?? "");
	const phase = toolPhase(part, { streaming });
	if (phase === "preparing" || phase === "running") return { name: search ? "Searching" : "Reading", target };
	if (phase === "stopped") return { name: "Did not finish", target };
	if (phase === "failed") return { name: search ? "Could not search" : "Could not read", target };
	return { name: search ? "Searched" : "Read", target };
}

function outputOf(part: ToolRendererProps["part"]) {
	return part.state === "output-available" ? (part.output as Output | undefined) : undefined;
}

function pages(name: string, output: Output | undefined) {
	if (!output) return [];
	if (name === "web_search") return output.results ?? [];
	return output.url && !output.error ? [{ url: output.url, title: output.title }] : [];
}
