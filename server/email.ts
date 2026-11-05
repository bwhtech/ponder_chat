/**
 * Email from Seva: only sign-in links for now. Sent with Cloudflare Email Service's REST
 * API when it is set up (SEVA_EMAIL_FROM, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_TOKEN);
 * otherwise, as on a laptop, the message is printed to the server log.
 */
type Email = { to: string; subject: string; text: string; html: string };

const from = process.env.SEVA_EMAIL_FROM;
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

export function signInEmail(to: string, url: string): Email {
	return {
		to,
		subject: "Sign in to Seva Chat",
		text: `Open this link to sign in to Seva Chat:\n\n${url}\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
		html: `<p>Open this link to sign in to Seva Chat:</p><p><a href="${url}">Sign in to Seva Chat</a></p><p style="color:#666">It works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>`,
	};
}
