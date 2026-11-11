import { ChatSendButton } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { QueueListIcon } from "@heroicons/react/24/outline";

/**
 * Send while ready; Stop while the reply is on its way. While busy with something to send,
 * it shows Queue instead, so a click queues like Enter does.
 */
export default function SendButton({ busy, canSubmit, onSubmit, onStop }: { busy: boolean; canSubmit: boolean; onSubmit: () => void; onStop: () => void }) {
	if (busy && canSubmit) {
		return <IconButton label="Queue" tooltip="Queue" variant="primary" icon={<Icon icon={QueueListIcon} />} onClick={onSubmit} data-slot="prompt-input-submit" />;
	}
	return <ChatSendButton isStopShown={busy} isDisabled={!canSubmit} onSend={onSubmit} onStop={onStop} data-slot="prompt-input-submit" />;
}
