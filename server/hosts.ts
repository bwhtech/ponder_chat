/**
 * The hosts Ponder answers on, from PONDER_HOSTS (comma-separated, such as
 * "chat.example.org"). Sign-in links use them (auth.ts), and so do the OAuth redirect
 * URLs of connectors (mcp/oauth.ts). Local hosts default to the port Ponder listens on.
 */
export const hosts = (process.env.PONDER_HOSTS ?? `localhost:${process.env.PORT ?? 3500},127.0.0.1:${process.env.PORT ?? 3500}`)
	.split(",")
	.map((host) => host.trim())
	.filter(Boolean);

/** A host on this machine is served over http; every other host over https. */
export const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1)(:|$)/.test(host);

export const originOf = (host: string) => `${isLocalHost(host) ? "http" : "https"}://${host}`;
