import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { EnvelopeOpenIcon } from "@heroicons/react/24/outline";
import { useRef, useState, type FormEvent } from "react";
import { sendSignInLink, signInWithCode } from "./lib/account";

/**
 * Sign-in by email: no passwords. A new email signs up. The email holds a 6-digit code
 * and a link; the person types the code here or opens the link.
 */

// Fixed text for the codes we know, so a crafted URL cannot put its own words on the page.
const linkErrors: Record<string, string> = {
	BANNED_USER: "This account is blocked. Ask the person who invited you.",
	NOT_INVITED: "This email is not invited to Ponder Chat.",
};

/** Why a link from the email did not sign the person in: the server sends them back here with a code. */
function linkError() {
	const params = new URL(location.href).searchParams;
	if (!params.has("sign-in") && !params.has("error")) return "";
	const message = linkErrors[params.get("error") ?? ""] ?? "That link has expired or was already used. Ask for a new one.";
	// Shown once: a reload or a shared link should not say it again.
	const url = new URL(location.href);
	url.searchParams.delete("sign-in");
	url.searchParams.delete("error");
	history.replaceState(history.state, "", url);
	return message;
}

export default function SignIn() {
	const [email, setEmail] = useState("");
	const [sending, setSending] = useState(false);
	const [sentTo, setSentTo] = useState("");
	const [error, setError] = useState(linkError);
	const [code, setCode] = useState("");
	const [checking, setChecking] = useState(false);
	const [codeError, setCodeError] = useState("");
	// Each code check takes a number; "Use another email" moves it on, so a check still on its way is ignored.
	const attempt = useRef(0);

	async function send(event: FormEvent) {
		event.preventDefault();
		if (sending) return;
		if (!email.trim()) return setError("Enter your email address.");
		setSending(true);
		setError("");
		try {
			await sendSignInLink(email.trim());
			setSentTo(email.trim());
			setCode("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}

	async function checkCode(event: FormEvent) {
		event.preventDefault();
		if (code.length !== 6 || checking) return;
		const mine = ++attempt.current;
		setChecking(true);
		try {
			await signInWithCode(sentTo, code, () => mine === attempt.current);
		} catch (cause) {
			if (mine === attempt.current) setCodeError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (mine === attempt.current) setChecking(false);
		}
	}

	function useAnotherEmail() {
		attempt.current++;
		setChecking(false);
		setCodeError("");
		setSentTo("");
	}

	return (
		<main className="flex min-h-dvh items-center justify-center px-4" data-slot="sign-in">
			<VStack gap={8} className="w-full max-w-sm">
				<VStack gap={3} hAlign="center" className="text-center">
					<img src="/logo.png" alt="" className="mb-1 size-11" />
					<Heading level={1}>Sign in to Ponder Chat</Heading>
					<Text color="secondary">We'll email you a code and a link. No password needed.</Text>
				</VStack>

				{sentTo ? (
					<Card padding={4}>
						<VStack gap={4}>
							<VStack gap={2} hAlign="center" className="text-center">
								<Icon icon={EnvelopeOpenIcon} size="lg" color="secondary" />
								<Text>
									Check your email. We sent a code to <Text weight="semibold">{sentTo}</Text>.
								</Text>
							</VStack>
							<form onSubmit={checkCode}>
								<VStack gap={3}>
									<TextInput
										label="Code"
										value={code}
										onChange={(value) => {
											// Digits only, so a pasted "123 456" still works.
											setCode(value.replace(/\D/g, "").slice(0, 6));
											setCodeError("");
										}}
										placeholder="123456"
										inputMode="numeric"
										autoComplete="one-time-code"
										hasAutoFocus
										status={codeError ? { type: "error", message: codeError } : undefined}
										statusVariant="detached"
										width="100%"
									/>
									<Button type="submit" label="Sign in" variant="primary" width="100%" isLoading={checking} isDisabled={code.length !== 6} />
								</VStack>
							</form>
							<Text type="supporting" color="secondary" className="text-center">
								Or open the link in the email. The code and the link expire in 15 minutes.
							</Text>
							<Button label="Use another email" variant="ghost" onClick={useAnotherEmail} />
						</VStack>
					</Card>
				) : (
					<form onSubmit={send}>
						<VStack gap={3}>
							<TextInput type="email" label="Email" value={email} onChange={setEmail} placeholder="you@example.org" autoComplete="email" hasAutoFocus width="100%" />
							<Button type="submit" label="Email me a link" variant="primary" width="100%" isLoading={sending} />
						</VStack>
					</form>
				)}

				{error && <Banner status="error" title="Could not sign you in" description={error} />}
			</VStack>
		</main>
	);
}
