import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowRightStartOnRectangleIcon, BoltIcon, EnvelopeIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { authClient, me, signOut } from "../lib/account";
import { credits } from "../lib/numbers";
import { useStore } from "../lib/store";
import { toast, toastError } from "../lib/toast";
import { PanelHeading, SettingsCard, SettingsRow } from "./panel";

/** Settings, Account: the person's name, who is signed in, and their daily credits. */
export default function AccountPanel() {
	const person = useStore(me);
	if (!person) return null;
	const { limit, extra, remaining } = person.credits;
	return (
		<div className="flex flex-col gap-5">
			<PanelHeading title="Account" />
			<SettingsCard>
				<SettingsRow title="Name" icon={UserIcon} description="Shown in the side nav. Without one, the start of your email stands in." control={<NameInput />} />
				<SettingsRow
					title="Signed in as"
					icon={EnvelopeIcon}
					description={person.user.email}
					control={<Button label="Sign out" variant="secondary" size="sm" icon={<Icon icon={ArrowRightStartOnRectangleIcon} />} onClick={() => void signOut()} />}
				/>
				<SettingsRow
					title="Daily credits"
					icon={BoltIcon}
					description={`You get ${credits(limit - extra)} credits a day. Each reply uses credits by what the model charges for it, so bigger models use more. Credits refill at midnight UTC.${extra ? ` Today you also have ${credits(extra)} extra credits from an admin.` : ""}`}
					control={
						<Text type="supporting" color="secondary" hasTabularNumbers textWrap="nowrap">
							{credits(remaining)} left today
						</Text>
					}
				/>
			</SettingsCard>
		</div>
	);
}

/** The name, saved when the person presses Enter or leaves the field. */
function NameInput() {
	const saved = useStore(me)?.user.name ?? "";
	const [name, setName] = useState(saved);
	const [saving, setSaving] = useState(false);
	useEffect(() => setName(saved), [saved]);

	async function save() {
		const next = name.trim();
		if (next === saved.trim() || saving) return;
		setSaving(true);
		try {
			const { error } = await authClient.updateUser({ name: next });
			if (error) throw new Error(error.message ?? "Your name was not saved.");
			me.set((current) => (current ? { ...current, user: { ...current.user, name: next } } : current));
			toast(next ? "Saved your name" : "Removed your name");
		} catch (error) {
			setName(saved);
			toastError(error instanceof Error ? error.message : "Your name was not saved.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<TextInput
			label="Name"
			isLabelHidden
			size="sm"
			width={192}
			value={name}
			placeholder="Your name"
			autoComplete="name"
			isLoading={saving}
			onChange={setName}
			onEnter={() => void save()}
			onKeyDown={(event) => {
				// Escape puts the saved name back first; a second Escape closes Settings.
				if (event.key !== "Escape" || name === saved) return;
				event.stopPropagation();
				setName(saved);
			}}
			onBlur={() => void save()}
		/>
	);
}
