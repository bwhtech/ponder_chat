import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { useMemo } from "react";
import type { Artifact } from "../side-panel/panel";
import { framedPage, HTML_SANDBOX } from "./html";

/**
 * An HTML artifact in the panel: the running page, or its code. While the reply writes it,
 * the code shows; the page runs once it is finished, so it does not restart on every word.
 * The frame stays when the person looks at the code, so the page keeps its state.
 */
export default function HtmlView({ artifact, view }: { artifact: Artifact; view: "preview" | "code" }) {
	const page = useMemo(() => (artifact.writing ? "" : framedPage(artifact.content)), [artifact.writing, artifact.content]);
	const showCode = artifact.writing || view === "code";
	return (
		<div className="flex h-full min-h-0 flex-col">
			{page && (
				<iframe
					srcDoc={page}
					sandbox={HTML_SANDBOX}
					referrerPolicy="no-referrer"
					title={artifact.title}
					className={`min-h-0 w-full flex-1 border-0 bg-surface ${showCode ? "hidden" : ""}`}
				/>
			)}
			{showCode && <CodeBlock code={artifact.content} language="html" container="section" width="100%" hasLanguageLabel={false} />}
		</div>
	);
}
