import { ChatComposer } from "@astryxdesign/core/Chat";
import type { ReactNode } from "react";
import ModelPicker from "./ModelPicker";

/**
 * The message field: what the person writes, the model, Send and Stop. ChatView owns the
 * state; the slots (drawer, header actions) take what other features add: attachments,
 * skills, quotes.
 */
export type ComposerProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit: (value: string) => void;
	onStop: () => void;
	busy: boolean;
	model: string;
	onModelChange: (id: string) => void;
	placeholder: string;
	isDisabled?: boolean;
	status?: { type: "error" | "warning"; message?: string };
	/** Chips above the field: attached files, chosen skills, quotes. */
	drawer?: ReactNode;
	/** Icon buttons at the top left: attach. */
	headerActions?: ReactNode;
	/** The field itself, when a feature needs its own (skills' $ trigger). */
	input?: ReactNode;
};

export default function Composer(props: ComposerProps) {
	return (
		<ChatComposer
			value={props.value}
			onChange={props.onChange}
			onSubmit={props.onSubmit}
			onStop={props.onStop}
			isStopShown={props.busy}
			placeholder={props.placeholder}
			isDisabled={props.isDisabled}
			status={props.status}
			drawer={props.drawer}
			headerActions={props.headerActions}
			input={props.input}
			footerActions={<ModelPicker value={props.model} onChange={props.onModelChange} />}
		/>
	);
}
