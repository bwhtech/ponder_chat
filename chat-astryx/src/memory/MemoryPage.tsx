import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Code } from "@astryxdesign/core/Code";
import { Text } from "@astryxdesign/core/Text";
import { ExclamationCircleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMemory, type MemoryOverview } from "../lib/memory";
import Decisions from "./Decisions";
import Memories from "./Memories";

type Tab = "memories" | "decisions" | "prompt";

/** What Ponder remembers about the person, the decisions behind it, and the prompt that decides. */
export default function MemoryPage({ onOpenThread }: { onOpenThread: (id: string) => void }) {
	const [overview, setOverview] = useState<MemoryOverview>();
	/** The last load failed. Its error replaces the tabs and what loaded before, with Try again. */
	const [loadError, setLoadError] = useState("");
	const [tab, setTab] = useState<Tab>("memories");
	// Each load takes a number: after two undos, the older answer arriving last is dropped.
	const asked = useRef(0);

	const load = useCallback(async () => {
		const mine = ++asked.current;
		setLoadError("");
		try {
			const next = await fetchMemory();
			if (mine === asked.current) setOverview(next);
		} catch (error) {
			if (mine === asked.current) setLoadError((error as Error).message);
		}
	}, []);

	useEffect(() => void load(), [load]);

	return (
		<div data-slot="memory-view" className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-3 py-6 sm:px-5">
				<Text type="body" color="secondary">
					Ponder remembers what you tell it about yourself, your work and how you like answers, and uses it in new chats so you don't have to repeat yourself. It never
					keeps passwords, contact details, ID numbers, health details, or what you say about other people.
				</Text>

				{loadError ? (
					<EmptyState
						icon={<Icon icon={ExclamationCircleIcon} size="lg" color="error" />}
						title="Your memory could not load"
						description={loadError}
						actions={<Button label="Try again" variant="secondary" onClick={() => void load()} />}
					/>
				) : (
					<>
						{overview && !overview.enabled && (
							<Banner status="warning" title="Memory is off" description="The server runs with PONDER_MEMORY=off, so new chats neither use nor add memories." />
						)}
						<div>
							<SegmentedControl label="Memory" value={tab} onChange={(value) => setTab(value as Tab)}>
								<SegmentedControlItem value="memories" label="Memories" />
								<SegmentedControlItem value="decisions" label="Decisions" />
								<SegmentedControlItem value="prompt" label="How it decides" />
							</SegmentedControl>
						</div>
						{!overview ? (
							<LoadingRows />
						) : tab === "memories" ? (
							<Memories memories={overview.memories} onChanged={load} onOpenThread={onOpenThread} />
						) : tab === "decisions" ? (
							<Decisions saves={overview.saves} onChanged={load} onOpenThread={onOpenThread} />
						) : (
							<div className="flex flex-col gap-2">
								<Text type="supporting" color="secondary">
									After each reply, a decision model answers two questions, and only on a yes does a small model write the changes. Both live in <Code size="inherit">server/memory/</Code>.
									Search: {overview.adapter}.
								</Text>
								<CodeBlock code={overview.prompt} size="sm" isWrapped width="100%" maxHeight="60vh" hasCopyButton={false} />
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/** Rows shaped like memories while they load: a line of text, then its kind and age. */
function LoadingRows() {
	return (
		<div className="flex flex-col divide-y divide-border rounded-lg border border-border" aria-busy="true" aria-label="Loading memories">
			{["80%", "60%", "66%"].map((width, index) => (
				<div key={width} className="flex flex-col gap-2 px-3 py-3">
					<Skeleton width={width} height={16} index={index} />
					<div className="flex items-center gap-2">
						<Skeleton width={56} height={16} index={index} />
						<Skeleton width={64} height={12} index={index} />
					</div>
				</div>
			))}
		</div>
	);
}
