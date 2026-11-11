import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { PencilIcon } from "@heroicons/react/24/outline";
import type { ArtifactStep } from "./steps";

/** The steps of an artifact being written, under its card. The icons sit under the card's icon and the labels under its title. */
export default function ArtifactSteps({ title, steps }: { title: string; steps: ArtifactStep[] }) {
	return (
		<ol data-slot="artifact-steps" aria-label={`Steps for ${title}`} className="flex flex-col">
			{steps.map((step) => (
				<li key={step.key} data-slot="artifact-step" className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-3 py-0.5 pl-2">
					<span className="flex justify-center">
						<Icon icon={step.done ? "check" : PencilIcon} size="xsm" color="secondary" />
					</span>
					<span className={step.done ? undefined : "animate-pulse motion-reduce:animate-none"}>
						<Text type="supporting" color={step.done ? "secondary" : "primary"} maxLines={1}>
							{step.label}
						</Text>
						<VisuallyHidden>{step.done ? ", done" : ", writing"}</VisuallyHidden>
					</span>
				</li>
			))}
		</ol>
	);
}
