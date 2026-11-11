import { Skeleton } from "@astryxdesign/core/Skeleton";

/** Stands in for a thread the device does not have yet: turns shaped like the chat's, and the message field. */
const TURNS = [
	{ ask: 224, lines: ["100%", "92%", "60%"] },
	{ ask: 160, lines: ["100%", "80%"] },
];

export default function ThreadSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-slot="thread-skeleton" aria-busy="true" aria-label="Loading thread">
			<div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-8 overflow-hidden px-4 pt-8">
				{TURNS.map((turn, index) => (
					<div key={index} className="flex flex-col gap-6">
						<div className="self-end">
							<Skeleton width={turn.ask} height={36} radius={4} index={index} />
						</div>
						<div className="flex flex-col gap-2.5">
							{turn.lines.map((width) => (
								<Skeleton key={width} width={width} height={14} index={index} />
							))}
						</div>
					</div>
				))}
			</div>
			<div className="mx-auto w-full max-w-[720px] shrink-0 px-4 pb-5">
				<Skeleton height={96} radius={4} />
			</div>
		</div>
	);
}
