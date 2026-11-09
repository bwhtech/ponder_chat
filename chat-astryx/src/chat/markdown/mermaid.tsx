import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { createMarkdownFenceTransform, createMarkdownPlugin, type MarkdownExtensionNode, type MarkdownTransformContext } from "@astryxdesign/core/Markdown/plugins";
import { Text } from "@astryxdesign/core/Text";
import { CodeBracketIcon, ShareIcon } from "@heroicons/react/24/outline";
import type { Mounted } from "pele/lazy";
import { useEffect, useRef, useState } from "react";
import CopyButton from "../CopyButton";

type DiagramNode = MarkdownExtensionNode<"mermaid", "diagram", { readonly code: string; readonly complete: boolean }, "block">;

/** A ```mermaid fence, drawn as a diagram (MermaidBlock). */
export const mermaidPlugin = createMarkdownPlugin<"mermaid", DiagramNode>({
	name: "mermaid",
	apiVersion: 1,
	transform: (root, context) => diagramFences(context)(root, context),
	renderers: {
		diagram: {
			render: ({ node }) => <MermaidBlock code={node.data.code} complete={node.data.complete} />,
			toText: (node) => node.data.code,
		},
	},
});

/** Claims the mermaid fences. A fence still streaming is not complete: it shows its code until it closes. */
function diagramFences(context: MarkdownTransformContext) {
	const source = context.source.trimEnd();
	const open = !context.isFinal && (source.match(/^\s*(```|~~~)/gm)?.length ?? 0) % 2 === 1;
	return createMarkdownFenceTransform({
		languages: ["mermaid"],
		createNode: ({ code }) => ({
			type: "extension" as const,
			plugin: "mermaid" as const,
			name: "diagram" as const,
			display: "block" as const,
			// The open fence is the last thing in the source.
			data: { code, complete: !(open && source.endsWith(code.trimEnd())) },
		}),
	});
}

// The model writes the source, so it is untrusted: no links, and no images that would
// make the reader's browser fetch arbitrary URLs. Keep the direction the model wrote;
// the reply column is narrower than Pele's flip-to-vertical breakpoint (as in Frappe Wiki).
const OPTIONS = { links: false, images: false, autoDirection: false } as const;

/**
 * A mermaid diagram, drawn by Pele. While the fence still streams (`complete` false) it
 * shows the code; the diagram is drawn once the source is whole. A diagram that does not
 * parse falls back to its code, with the reason under it.
 */
function MermaidBlock({ code, complete }: { code: string; complete: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const diagram = useRef<Mounted | null>(null);
	const [showCode, setShowCode] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		const element = host.current;
		if (!complete || !element) return;
		let live = true;
		drawDiagram(element, code.trim(), diagram, () => live).then(
			(reason) => live && setError(reason),
			(reason: unknown) => live && setError(errorMessage(reason) || "The diagram could not be drawn."),
		);
		return () => {
			live = false;
		};
	}, [code, complete]);

	useEffect(
		() => () => {
			diagram.current?.destroy();
			diagram.current = null;
		},
		[],
	);

	const codeShown = !complete || showCode || Boolean(error);
	return (
		<div data-slot="mermaid-block" className="overflow-hidden rounded-md border border-border">
			<div className="flex items-center gap-1 border-b border-border py-1 pl-3 pr-1">
				<Text type="supporting">mermaid</Text>
				<div className="ml-auto flex items-center">
					{complete && !error && (
						<IconButton
							label={showCode ? "Show diagram" : "Show code"}
							tooltip={showCode ? "Show diagram" : "Show code"}
							variant="ghost"
							size="sm"
							icon={<Icon icon={showCode ? ShareIcon : CodeBracketIcon} />}
							onClick={() => setShowCode(!showCode)}
						/>
					)}
					<CopyButton value={code} />
				</div>
			</div>
			{codeShown && <CodeBlock code={code} container="section" hasCopyButton={false} size="sm" width="100%" maxHeight={384} isWrapped />}
			{complete && (
				<div hidden={codeShown} className="overflow-x-auto px-2.5 pb-2.5 pt-1.5">
					<div ref={host} data-slot="mermaid-diagram" className="w-full [&_svg]:mx-auto" />
				</div>
			)}
			{error && (
				<div className="border-t border-border px-3 py-1.5 text-error">
					<Text type="supporting" color="inherit">
						Could not draw this diagram: {error}
					</Text>
				</div>
			)}
		</div>
	);
}

/** Draws or redraws the diagram, and gives Pele's reason when it does not parse. */
async function drawDiagram(element: HTMLElement, source: string, diagram: { current: Mounted | null }, live: () => boolean) {
	const options = { ...OPTIONS, onRender: () => inkSliceLabels(element) };
	// Loaded on first use, with each diagram type fetched as it is needed.
	const { detectType, load, mountAsync } = await import("pele/lazy").catch(() => {
		// Most often a tab opened before a deploy, asking for a file the new release renamed.
		throw new Error("The diagram drawer could not load. Reload the page to try again.");
	});
	if (!live()) return "";
	if (diagram.current) {
		// update() draws only registered types; an edit may switch to a new one.
		await load(detectType(source)).catch(() => false);
		if (!live()) return "";
		diagram.current.update(source, options);
	} else {
		const mounted = await mountAsync(element, source, options);
		if (!live()) {
			mounted.destroy();
			return "";
		}
		diagram.current = mounted;
	}
	return diagram.current.result ? "" : errorMessage(diagram.current.error);
}

function errorMessage(reason: unknown) {
	return reason instanceof Error ? reason.message : reason ? String(reason) : "";
}

/**
 * Pele prints every pie label in one colour, but the series ramp (markdown.css) alternates
 * a strong and a pale member of each hue. Ink each label to suit its slice: the page colour
 * on the strong (odd) slots, primary text on the pale (even) ones. From Frappe Wiki.
 */
function inkSliceLabels(element: HTMLElement) {
	const slices = Array.from(element.querySelectorAll<SVGGeometryElement>(".pele-slice"));
	for (const label of Array.from(element.querySelectorAll<SVGTextElement>(".pele-slice-labels[fill] text"))) {
		const point = new DOMPoint(Number(label.getAttribute("x")), Number(label.getAttribute("y")));
		const slice = slices.find((path) => path.isPointInFill(point));
		const series = Number(slice?.getAttribute("fill")?.match(/--pele-series-(\d+)/)?.[1]);
		if (series) label.style.fill = series % 2 ? "var(--color-background-body)" : "var(--color-text-primary)";
	}
}
