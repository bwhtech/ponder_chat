/**
 * Alerts for the admins' phones: a short message to NOTIFY_URL, an ntfy topic (the same
 * one deploy/sentinel.sh sends to). Without NOTIFY_URL, the message goes to the log.
 * Anyone who knows the topic can read it, so a message never holds chat content.
 */
export async function notifyAdmins(title: string, message: string, click?: string) {
	const url = process.env.NOTIFY_URL;
	if (!url) return console.log(`notify (no NOTIFY_URL): ${title}: ${message}`);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { Title: title, Tags: "ponder-chat", ...(click && { Click: click }) },
			body: message,
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) console.error(`notify: ntfy answered ${response.status}`);
	} catch (error) {
		console.error("notify:", error instanceof Error ? error.message : error);
	}
}
