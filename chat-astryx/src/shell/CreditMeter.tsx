import { VStack, HStack } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import type { Credits } from "../lib/account";
import { fromNow } from "../lib/dates";
import { credits as creditCount } from "../lib/numbers";

/** Today's credits: what is left, a bar, and when they refill. */
export default function CreditMeter({ credits }: { credits: Credits }) {
	const left = Math.max(0, Math.min(1, credits.remaining / Math.max(1, credits.limit)));
	const empty = credits.remaining <= 0;
	const low = left < 0.2;
	return (
		<VStack gap={1.5} className="px-3 py-2" data-slot="credit-meter">
			<HStack hAlign="between" vAlign="center" gap={2}>
				<Text type="supporting" color="secondary">
					Credits left
				</Text>
				<Text type="supporting" className="tabular-nums">
					<span className={empty ? "text-error" : low ? "text-warning" : undefined}>{creditCount(credits.remaining)}</span>
					<span className="text-secondary"> / {creditCount(credits.limit)}</span>
				</Text>
			</HStack>
			<ProgressBar label="Credits left today" isLabelHidden value={left * 100} variant={empty ? "error" : low ? "warning" : undefined} />
			<Text type="supporting" color="secondary">
				Refills {fromNow(credits.resetsAt)}
			</Text>
		</VStack>
	);
}
