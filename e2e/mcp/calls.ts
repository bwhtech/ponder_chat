/** A tool call that a test MCP server ran (server.ts). Shared with the tests, which read them over HTTP. */
export type McpCall = { server: "open" | "key" | "oauth"; tool: string; args: Record<string, unknown>; at: number };
