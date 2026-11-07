/**
 * Email from Ponder: sign-in codes, invites, and answers to requests for more credits. Sent with Cloudflare Email Service's REST
 * API when it is set up (PONDER_EMAIL_FROM, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_TOKEN);
 * otherwise, as on a laptop, the message is printed to the server log.
 */
type Email = { to: string; subject: string; text: string; html: string };

const from = process.env.PONDER_EMAIL_FROM;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_EMAIL_TOKEN;

export async function sendEmail(email: Email) {
	if (!from || !account || !token) {
		console.log(`email (not sent, no sender set up) to ${email.to}: ${email.subject}\n${email.text}`);
		return;
	}
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ from, ...email }),
	});
	if (!response.ok) throw new Error(`The email could not be sent (${response.status}): ${await response.text()}`);
}

/**
 * The sign-in email: a 6-digit code, large so it is easy to read, and the link below it.
 * A code asked for on its own (auth.ts) comes without the link.
 */
export function signInEmail(to: string, code: string, url?: string): Email {
	const expiry = url ? "The code and the link expire in 15 minutes. Each works once." : "The code expires in 15 minutes and works once.";
	const ignore = "If you did not ask to sign in, ignore this email.";
	const linkText = url ? `\n\nOr open this link to sign in:\n\n${url}` : "";
	const linkHtml = url ? `<p>Or open this link to sign in:</p><p><a href="${url}">Sign in to Ponder Chat</a></p>` : "";
	return {
		to,
		// The code in the subject, so it shows in the notification without opening the email.
		subject: `${code} is your OTP for PonderChat.`,
		text: `Your code to sign in to Ponder Chat:\n\n${code}\n\nType it on the sign-in page.${linkText}\n\n${expiry} ${ignore}`,
		html:
			`<p>Your code to sign in to Ponder Chat:</p>` +
			`<p style="margin:16px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:6px">${code}</p>` +
			`<p>Type it on the sign-in page.</p>${linkHtml}` +
			`<p style="color:#666">${expiry} ${ignore}</p>`,
	};
}

/** An admin invited this email (/admin, People). `url` is Ponder's sign-in page. */
export function inviteEmail(to: string, url: string): Email {
	const steps = `Open ${url}, type this email address (${to}), and Ponder Chat sends you a code to sign in.`;
	return {
		to,
		subject: "You are invited to Ponder Chat",
		text: `You are invited to Ponder Chat.\n\n${steps}\n\nYou do not need a password.`,
		html:
			`<p>You are invited to Ponder Chat.</p>` +
			`<p>Open <a href="${url}">${url}</a>, type this email address (${to}), and Ponder Chat sends you a code to sign in.</p>` +
			`<p style="color:#666">You do not need a password.</p>`,
	};
}

/** An admin answered the person's request for more credits. */
export function creditAnswerEmail(to: string, url: string, credits: number | null): Email {
	const answer = credits
		? `An admin gave you ${credits} more credits for today. They are added to today's limit.`
		: "An admin did not give you more credits today.";
	const refill = "Your credits refill at midnight UTC as usual.";
	return {
		to,
		subject: credits ? "You have more credits for today" : "About your request for more credits",
		text: `${answer} ${refill}\n\nOpen Ponder Chat: ${url}`,
		html: `<p>${answer}</p><p>${refill}</p><p><a href="${url}">Open Ponder Chat</a></p>`,
	};
}
