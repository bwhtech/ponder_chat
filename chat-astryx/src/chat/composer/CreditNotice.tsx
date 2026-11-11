import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { me } from "../../lib/account";
import { askForMoreCredits, outOfCreditsNotice } from "../../lib/credit-request";
import { clockTime } from "../../lib/dates";
import { useStore } from "../../lib/store";
import { toastError } from "../../lib/toast";

/** Out of credits: when they refill, and a way to ask the admins for more (credit-request.ts). */
export default function CreditNotice() {
	const credits = useStore(me)?.credits;
	const confirm = useImperativeAlertDialog();
	if (!credits || credits.remaining > 0) return null;
	// While a request for more credits waits, the notice says so and has no button.
	const notice = outOfCreditsNotice(credits, clockTime(credits.resetsAt));

	function ask() {
		confirm.show({
			title: "Request more credits",
			description: "Ask the admins for more credits? This sends them a request with how much you've used today. You'll get an email when they answer.",
			actionLabel: "Send request",
			actionVariant: "primary",
			onAction: async () => {
				try {
					await askForMoreCredits();
				} catch (error) {
					toastError(error instanceof Error ? error.message : String(error));
				}
				confirm.hide();
			},
		});
	}

	return (
		<>
			<Banner
				status="warning"
				title="You've used today's credits"
				description={notice.description}
				endContent={notice.canAsk ? <Button label="Request more credits" variant="secondary" size="sm" onClick={ask} /> : undefined}
				data-slot="out-of-credits"
			/>
			{confirm.element}
		</>
	);
}
