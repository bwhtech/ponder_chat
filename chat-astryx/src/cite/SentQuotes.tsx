import type { UIMessage } from "ai";
import { SentCitationChip } from "./CitationChip";
import { chosenCitations, type Citation } from "./citations";

/** The quotes on a message the person sent; each opens a card with Go to source. */
export default function SentQuotes({ message, onReveal }: { message: UIMessage; onReveal: (citation: Citation) => void }) {
	const quotes = chosenCitations(message);
	if (!quotes.length) return null;
	return (
		<div className="flex max-w-full flex-wrap justify-end gap-1.5 self-end" data-slot="message-quotes">
			{quotes.map((citation, index) => (
				<SentCitationChip key={`quote-${index}`} citation={citation} onReveal={() => onReveal(citation)} />
			))}
		</div>
	);
}
