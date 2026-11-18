// The JSON body of a fetch Request or Response is `unknown`, not `any`, as in types/json.d.ts.
// The browser's types declare json() on Body, which Request and Response extend. Node's
// undici types already answer `unknown`, but with the browser's types in the program
// (TypeScript's default lib), Node's Request and Response are the browser's.
interface Body {
	json(): Promise<unknown>;
}
