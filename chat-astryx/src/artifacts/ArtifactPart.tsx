import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef } from "react";
import type { ToolPart, ToolRendererProps } from "../chat/tool-renderers";
import { useStore } from "../lib/store";
import { ARTIFACT_LOOK } from "../side-panel/header";
import { panel, updateArtifact, viewArtifact, type Artifact, type ArtifactKind } from "../side-panel/panel";
import ArtifactSteps from "./ArtifactSteps";
import { slideCount } from "./slides";
import { artifactSteps, currentStepText } from "./steps";

/**
 * A write_artifact call (server/artifacts/schema.ts) as a card in the reply. A click opens
 * the artifact in the side panel. Each call is one version: its card opens that version.
 *
 * A reply that starts writing one opens it in the panel on a wide screen. A panel that
 * already shows an artifact moves to the new one; a file the person opened stays.
 *
 * While the reply writes it, the card lists the steps so far under it: a deck's look,
 * then each slide by its heading, or a document's sections. They go when it is written.
 */
type Input = Partial<{ id: string; kind: ArtifactKind; title: string; content: string }>;
const KINDS: ArtifactKind[] = ["document", "slides", "html"];

export default function ArtifactPart({ part, streaming }: ToolRendererProps) {
	const key = `artifact:${part.toolCallId}`;
	const { writing, failed } = callState(part, streaming);
	const input = ((part as { input?: unknown }).input ?? {}) as Input;
	const artifact = useMemo<Artifact>(
		() => ({
			id: input.id ?? "",
			kind: input.kind && KINDS.includes(input.kind) ? input.kind : "document",
			title: input.title?.trim() || "Untitled",
			content: input.content ?? "",
			writing,
		}),
		[input.id, input.kind, input.title, input.content, writing],
	);
	const isOpen = useStore(panel)?.key === key;
	const look = ARTIFACT_LOOK[artifact.kind];
	const steps = artifact.writing ? artifactSteps(artifact.kind, artifact.content, false) : [];

	// An open artifact follows the reply as it writes.
	useEffect(() => updateArtifact(key, artifact), [key, artifact]);

	// Opens the panel once, when the reply starts writing this version.
	const latest = useRef(artifact);
	latest.current = artifact;
	const started = artifact.writing && Boolean(artifact.id);
	useEffect(() => {
		const shown = panel.get();
		if (!started || shown?.key === key) return;
		if (shown?.type === "artifact" || (!shown && matchMedia("(min-width: 1024px)").matches)) viewArtifact(key, latest.current);
	}, [started, key]);

	function open() {
		if (!failed) viewArtifact(key, artifact);
	}

	const detail = failed ? "Could not be written" : artifact.kind === "slides" ? `${look.label} · ${slideCount(artifact.content)} slides` : look.label;
	return (
		<div className="my-1.5 flex max-w-sm flex-col gap-1.5" data-slot="artifact">
			<ClickableCard label={`Open ${artifact.title}`} onClick={open} isDisabled={failed} variant={isOpen ? "muted" : "default"} padding={2}>
				<div className="flex items-center gap-3" data-slot="artifact-card" data-open={isOpen || undefined}>
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true">
						<Icon icon={look.icon} color={look.color} />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<Text type="label" weight="semibold" maxLines={1}>
							{artifact.title}
						</Text>
						{artifact.writing ? (
							<span className="animate-pulse motion-reduce:animate-none">
								<Text type="supporting" maxLines={1}>
									{currentStepText(artifact.kind, steps)}
								</Text>
							</span>
						) : (
							<span className={failed ? "text-error" : undefined}>
								<Text type="supporting" color={failed ? "inherit" : "secondary"} maxLines={1}>
									{detail}
								</Text>
							</span>
						)}
					</span>
					{!failed && <Icon icon={ChevronRightIcon} size="sm" color="secondary" />}
				</div>
			</ClickableCard>
			{steps.length > 0 && <ArtifactSteps title={artifact.title} steps={steps} />}
		</div>
	);
}

/** Written while the call's input streams; failed when the call failed or the reply stopped mid-way. */
function callState(part: ToolPart, streaming: boolean) {
	const state = part.state;
	return {
		writing: state === "input-streaming" && streaming,
		failed: state === "output-error" || (state === "input-streaming" && !streaming),
	};
}
