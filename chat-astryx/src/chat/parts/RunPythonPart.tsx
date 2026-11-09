import { ChatToolCalls } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Link } from "@astryxdesign/core/Link";
import { viewOnClick } from "../../side-panel/panel";
import type { ToolRendererProps } from "../tool-renderers";
import FileChip from "./FileChip";
import { callStatus, phaseError, toolPhase } from "./tool-state";

/**
 * A run_python call (server/python/tool.ts): the code and what it printed, folded under a
 * line, and the files it made below, always in view: images drawn, the rest as chips
 * to download.
 */
type Input = { code?: string; inputs?: { name: string; file_id?: string }[] };
type OutputFile = { name: string; url: string; media_type: string; size: number };
type Output = { ok?: boolean; stdout?: string; stderr?: string; files?: OutputFile[]; error?: string };

export default function RunPythonPart({ part, streaming }: ToolRendererProps) {
	const input = ((part as { input?: unknown }).input ?? {}) as Input;
	const output = part.state === "output-available" ? (part.output as Output | undefined) : undefined;
	// The output can report a failure itself; the line's status and the content both read it.
	const phase = toolPhase(part, { streaming, failed: !!output?.error || output?.ok === false });
	const failed = phase === "failed";
	const images = output?.files?.filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.media_type)) ?? [];
	const others = output?.files?.filter((file) => !images.includes(file)) ?? [];
	const printed = [output?.stdout, failed ? output?.error || output?.stderr : ""].filter(Boolean).join("\n").trim();
	const detail =
		input.code || printed ? (
			<div className="flex flex-col gap-2">
				{input.code && <CodeBlock title="main.py" language="python" code={input.code} size="sm" width="100%" maxHeight={384} />}
				{printed && <CodeBlock title="Output" language="plaintext" code={printed} size="sm" width="100%" maxHeight={384} isWrapped />}
			</div>
		) : undefined;

	return (
		<div className="flex flex-col gap-2" data-slot="run-python">
			<ChatToolCalls
				calls={[{ key: part.toolCallId, name: title(phase, output), status: callStatus(phase), errorMessage: phaseError(part, phase), resultDetail: detail }]}
			/>
			{images.map((image) => (
				<Link
					key={image.url}
					href={image.url}
					target="_blank"
					onClick={(event) => viewOnClick(event, { name: image.name, url: image.url, mediaType: image.media_type })}
				>
					<img src={image.url} alt={image.name} loading="lazy" className="max-h-[440px] max-w-full rounded-lg border border-border bg-surface p-2" />
				</Link>
			))}
			{others.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{others.map((file) => (
						<FileChip key={file.url} name={file.name} url={file.url} mediaType={file.media_type} size={file.size} />
					))}
				</div>
			)}
		</div>
	);
}

function title(phase: ReturnType<typeof toolPhase>, output: Output | undefined) {
	if (phase === "preparing" || phase === "running") return "Running Python";
	if (phase === "stopped") return "Python did not finish";
	if (output?.error?.includes("was stopped")) return "Python was stopped";
	return phase === "failed" ? "Python stopped with an error" : "Ran Python";
}
