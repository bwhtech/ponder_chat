// The browser-only typecheck (tsconfig.json here) reads this in place of pg's types, which
// bring Node's. The API's types name pg's Pool only as a server option (server/auth/Auth.ts).
export declare class Pool {
	private readonly serverOnly: never;
}
