/**
 * The hosts Ponder answers on are PONDER_HOSTS (comma-separated, such as "chat.example.org"),
 * in PonderConfig's `hosts` (config.ts). Sign-in links use them (auth.ts), and so do the
 * OAuth redirect URLs of connectors (mcp/oauth.ts). Local hosts default to the port Ponder
 * listens on. These helpers turn a host into its address.
 */

/** A host on this machine is served over http; every other host over https. */
export const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1)(:|$)/.test(host);

export const originOf = (host: string) => `${isLocalHost(host) ? "http" : "https"}://${host}`;
