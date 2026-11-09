import { Markdown } from "@astryxdesign/core/Markdown";
import type { Artifact } from "../side-panel/panel";

/** A Markdown document in the panel, drawn as replies are, in a column that reads like a page. */
export default function DocumentView({ artifact }: { artifact: Artifact }) {
	return (
		<article className="mx-auto w-full max-w-[680px] px-5 pb-16 pt-8 sm:px-10 sm:pt-10">
			<Markdown isStreaming={artifact.writing} autolink="gfm" contentWidth="100%">
				{artifact.content}
			</Markdown>
		</article>
	);
}
