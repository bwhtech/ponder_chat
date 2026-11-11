import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowRightEndOnRectangleIcon, CheckCircleIcon, DocumentDuplicateIcon, ExclamationCircleIcon, KeyIcon } from "@heroicons/react/24/outline";
import type { FormEvent } from "react";
import { toast } from "../lib/toast";
import HeadersInput from "./HeadersInput";
import type { Check, Notice, useAddConnector } from "./use-add-connector";

const redirectUrl = `${location.origin}/oauth/mcp/callback`;

/** The Add connector form: the server's URL, checked as the person types, its name, and a key or an OAuth app when it needs one. */
export default function AddConnectorForm({ add, onCancel }: { add: ReturnType<typeof useAddConnector>; onCancel: () => void }) {
	const { step, probe, form, result, headers } = add;

	function submit(event: FormEvent) {
		event.preventDefault();
		if (add.canAdd) void add.add();
	}

	function copyRedirect() {
		void navigator.clipboard?.writeText(redirectUrl);
		toast("Copied the redirect URL");
	}

	return (
		<form className="flex flex-col gap-4" onSubmit={submit}>
			{step.kind === "form" && step.notice && <NoticeBanner notice={step.notice} />}

			<div className="flex flex-col gap-1.5">
				<TextInput
					type="url"
					label="Server URL"
					placeholder="https://mcp.example.com/mcp"
					isRequired
					autoComplete="off"
					width="100%"
					value={form.url}
					onChange={add.setUrl}
				/>
				<ProbeLine probe={probe} onRetry={() => add.checkUrl()} />
			</div>

			<TextInput label="Name" description="How the connector shows in Ponder and in its tool calls." isRequired width="100%" value={form.name} onChange={(name) => add.setName(name.slice(0, 60))} />

			{result?.auth === "headers" && (
				<div className="flex flex-col gap-1.5">
					<Text type="label">API key</Text>
					<HeadersInput rows={headers} onChange={add.setHeaders} />
					<Text type="supporting" color="secondary">
						Saved encrypted. Ponder sends it only to this server and never shows it again.
					</Text>
				</div>
			)}

			<Collapsible trigger={<Text type="label">Advanced</Text>} defaultIsOpen={false} chevronPosition="start">
				<Card variant="muted" width="100%">
					<div className="flex flex-col gap-5">
						{(!result || result.auth === "oauth") && (
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-0.5">
									<Text type="label">Your own OAuth app</Text>
									<Text type="supporting" color="secondary">
										Only for a server that does not let Ponder register itself, such as GitHub. Register an app there with this redirect URL, then enter its ID and secret.
									</Text>
								</div>
								<div className="flex items-center gap-1 rounded-md bg-surface px-2.5 py-1">
									<span className="min-w-0 flex-1 truncate font-mono text-xs">{redirectUrl}</span>
									<IconButton label="Copy the redirect URL" variant="ghost" size="sm" icon={<Icon icon={DocumentDuplicateIcon} />} onClick={copyRedirect} />
								</div>
								<div className="grid gap-3 sm:grid-cols-2">
									<TextInput label="Client ID" autoComplete="off" width="100%" value={form.clientId} onChange={(clientId) => add.setForm((before) => ({ ...before, clientId }))} />
									<TextInput
										type="password"
										label="Client secret"
										autoComplete="off"
										width="100%"
										value={form.clientSecret}
										onChange={(clientSecret) => add.setForm((before) => ({ ...before, clientSecret }))}
									/>
								</div>
							</div>
						)}
						{(!result || result.auth !== "headers") && (
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-0.5">
									<Text type="label">Headers</Text>
									<Text type="supporting" color="secondary">
										Sent with every request to this server. Saved encrypted.
									</Text>
								</div>
								<HeadersInput rows={headers} onChange={add.setHeaders} />
							</div>
						)}
					</div>
				</Card>
			</Collapsible>

			<Text type="supporting" color="secondary">
				Only add servers you trust. Ponder runs their tools with your sign-in, and what they return goes to the model.
			</Text>

			<div className="flex justify-end gap-2 pt-2">
				<Button label="Cancel" variant="secondary" onClick={onCancel} />
				<Button type="submit" label={result?.auth === "oauth" ? "Connect" : "Add"} variant="primary" isLoading={step.kind === "adding"} isDisabled={!add.canAdd} />
			</div>
		</form>
	);
}

/** Why the form shows again: the sign-in was cancelled, its window closed, or adding failed. */
function NoticeBanner({ notice }: { notice: Notice }) {
	if (notice.kind === "cancelled") return <Banner status="warning" title="Sign-in cancelled" description="Nothing was saved. Connect again when you are ready." />;
	if (notice.kind === "closed")
		return (
			<Banner
				status="warning"
				title="The sign-in window closed"
				description="Connect again when you are ready. If you finished signing in, the connector shows here in a moment."
			/>
		);
	return <Banner status="error" title={notice.message} />;
}

/** What the server said about the URL, under the field. */
function ProbeLine({ probe, onRetry }: { probe: Check; onRetry: () => void }) {
	if (probe.kind === "idle")
		return (
			<Text type="supporting" color="secondary">
				The address of a remote MCP server. Ponder checks what it needs.
			</Text>
		);
	if (probe.kind === "checking")
		return (
			<div className="flex items-center gap-2">
				<Spinner size="sm" shade="subtle" />
				<Text type="supporting" color="secondary">
					Checking the server…
				</Text>
			</div>
		);
	const ok = probe.kind === "ok";
	const icon = ok ? { oauth: ArrowRightEndOnRectangleIcon, headers: KeyIcon, none: CheckCircleIcon }[probe.found.auth] : ExclamationCircleIcon;
	return (
		<div className={`flex items-start gap-2 ${ok ? "text-secondary" : "text-error"}`} aria-live="polite">
			<span className="pt-0.5">
				<Icon icon={icon} size="sm" />
			</span>
			<span className="min-w-0 flex-1">
				<Text type="supporting" color="inherit">
					{ok ? probe.found.message : probe.message}
				</Text>
			</span>
			{!ok && <Button label="Check again" variant="ghost" size="sm" onClick={onRetry} />}
		</div>
	);
}
