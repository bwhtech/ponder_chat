import { Citation } from "@astryxdesign/core/Citation";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { Link } from "@astryxdesign/core/Link";
import { Markdown, type MarkdownComponents } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { Children, createContext, isValidElement, use, type ReactNode } from "react";
import { hostname, sourceKey, type PageSource, type SourceIndex } from "./sources";

/**
 * Markdown for an assistant reply. With `sources` (sources.ts), a link to one of those
 * pages shows as a chip, and hovering or focusing it opens a card with the page's title
 * and an excerpt.
 */
export default function Reply({ text, streaming, sources }: { text: string; streaming: boolean; sources: SourceIndex }) {
	return (
		<Sources value={sources}>
			<Markdown density="compact" isStreaming={streaming} autolink="gfm" contentWidth="100%" components={components}>
				{text}
			</Markdown>
		</Sources>
	);
}

const Sources = createContext<SourceIndex>(new Map());

// One object for every reply, so a streamed chunk does not remount the links.
const components: Partial<MarkdownComponents> = { link: ReplyLink };

function ReplyLink({ href, children }: { href: string; children: ReactNode }) {
	const sources = use(Sources);
	const key = sourceKey(href);
	const source = key ? sources.get(key) : undefined;
	if (!source) {
		return (
			<Link href={href} target="_blank">
				{children}
			</Link>
		);
	}
	const number = [...sources.keys()].indexOf(key) + 1;
	return (
		<HoverCard content={<SourceCard source={source} />} delay={10} hideDelay={120} label={source.title || hostname(source.url)}>
			<Citation source={{ url: source.url, title: textOf(children) || hostname(source.url) }} number={number} />
		</HoverCard>
	);
}

/** The card for a citation chip: the page's title, its site and an excerpt. */
function SourceCard({ source }: { source: PageSource }) {
	return (
		<div className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1" data-slot="citation-card">
			<Text weight="medium" maxLines={2}>
				{source.title || hostname(source.url)}
			</Text>
			<Text type="supporting" maxLines={1}>
				<Link href={source.url} isExternalLink size="sm">
					{hostname(source.url)}
				</Link>
			</Text>
			{source.description && (
				<Text type="supporting" color="secondary" maxLines={4}>
					{source.description}
				</Text>
			)}
		</div>
	);
}

/** The link's own words, for the chip. */
function textOf(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : ""))
		.join("")
		.trim();
}
