import { ChatToolCalls } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { skillTitle } from "../../skills/skills";

/**
 * A live "working on it" line (lib/thinking.ts). It matches the reasoning line in the steps
 * ("Thinking" with a spinner), so when the model starts to think in the open, the line
 * stays where it is.
 */
export function ThinkingLine({ text }: { text: string }) {
	return (
		<div role="status" aria-live="polite" data-slot="thinking">
			<ChatToolCalls calls={[{ key: "thinking", name: text, status: "running" }]} />
		</div>
	);
}

/** The skills the person asked for in the message a reply answers, above the reply. */
export function AskedSkills({ names }: { names: string[] }) {
	return (
		<>
			{names.map((name) => (
				<div key={name} className="flex items-center gap-1.5 text-secondary" data-slot="asked-skill">
					<Icon icon={SparklesIcon} size="sm" />
					<Text type="supporting" color="secondary">
						Used skill{" "}
						<Text type="supporting" color="primary">
							{skillTitle(name)}
						</Text>{" "}
						· You asked for it
					</Text>
				</div>
			))}
		</>
	);
}
