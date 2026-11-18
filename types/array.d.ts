// Array.isArray narrows to `unknown[]`, not `any[]`, as in types/json.d.ts: an unknown value
// that is an array still has elements of unknown type.
interface ArrayConstructor {
	isArray(arg: unknown): arg is unknown[];
}
