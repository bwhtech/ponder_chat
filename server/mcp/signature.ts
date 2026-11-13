import { isObject } from "./rank.ts";

/**
 * A tool's input schema as a short TypeScript-like signature, for connector_search and
 * the connector note: `shop__add_note({ order: string; note?: string /* At most 200 characters *\/ })`.
 * Shorter than the JSON schema, and models read it as well. Limits that the model must
 * keep to (a maximum, a pattern) stay as comments. Based on vercel/eve's
 * packages/eve/src/tools/signature.ts. No imports but rank.ts: the workflow loads it.
 */
type Schema = Record<string, unknown>;

const MAX_LENGTH = 2_000;
const MAX_DEPTH = 6;
/** Shared $ref targets could otherwise grow the work without end. */
const MAX_NODES = 500;
const MAX_COMMENT = 120;
const LIMITS = ["format", "pattern", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "default"] as const;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function signature(name: string, inputSchema: Schema): string {
	const full = new Renderer(inputSchema, true).signature(name);
	if (full.length <= MAX_LENGTH) return full;
	// A field left out reads as a field the tool does not have, so names come before descriptions.
	const short = new Renderer(inputSchema, false).signature(name);
	return short.length <= MAX_LENGTH ? short : `${short.slice(0, MAX_LENGTH - 3)}...`;
}

class Renderer {
	private nodes = MAX_NODES;

	constructor(
		private root: Schema,
		private comments: boolean,
	) {}

	signature(name: string) {
		return `${name}(${this.type(this.root, 0, new Set())})`;
	}

	private type(schema: unknown, depth: number, refs: Set<string>): string {
		if (!isObject(schema) || depth > MAX_DEPTH || this.nodes-- <= 0) return "unknown";
		if (typeof schema.$ref === "string") {
			const target = this.resolve(schema.$ref, refs);
			return target ? this.type(target, depth, new Set([...refs, schema.$ref])) : "unknown";
		}
		if ("const" in schema) return JSON.stringify(schema.const);
		if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value)));
		const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
		if (variants) return union(variants.map((variant) => this.type(variant, depth + 1, refs)));
		if (Array.isArray(schema.allOf)) return schema.allOf.map((part) => wrap(this.type(part, depth + 1, refs))).join(" & ");
		const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter((type): type is string => typeof type === "string");
		if (types.length) return union(types.map((type) => this.primitive(type, schema, depth, refs)));
		if (isObject(schema.properties)) return this.object(schema, depth, refs);
		return "unknown";
	}

	private primitive(type: string, schema: Schema, depth: number, refs: Set<string>) {
		if (type === "integer") return "number";
		if (type === "array") return `${wrap(this.type(schema.items, depth + 1, refs))}[]`;
		if (type === "object") return this.object(schema, depth, refs);
		return ["string", "number", "boolean", "null"].includes(type) ? type : "unknown";
	}

	private object(schema: Schema, depth: number, refs: Set<string>) {
		const properties = isObject(schema.properties) ? schema.properties : {};
		const required = new Set(Array.isArray(schema.required) ? schema.required : []);
		const fields = Object.entries(properties).map(([key, value]) => {
			const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
			return `${name}${required.has(key) ? "" : "?"}: ${this.type(value, depth + 1, refs)}${this.comment(value)}`;
		});
		if (isObject(schema.additionalProperties)) fields.push(`[key: string]: ${this.type(schema.additionalProperties, depth + 1, refs)}`);
		if (!fields.length) return schema.additionalProperties === false ? "{}" : "Record<string, unknown>";
		return `{ ${fields.join("; ")} }`;
	}

	private comment(schema: unknown) {
		if (!isObject(schema)) return "";
		const parts: string[] = [];
		if (this.comments && typeof schema.description === "string") {
			const text = schema.description.replace(/\s+/g, " ").replace(/[\s.;,:]+$/, "").trim();
			if (text) parts.push(text.length > MAX_COMMENT ? `${text.slice(0, MAX_COMMENT - 1)}…` : text);
		}
		for (const key of LIMITS) if (schema[key] !== undefined) parts.push(`${key}: ${JSON.stringify(schema[key])}`);
		return parts.length ? ` /* ${parts.join("; ").replaceAll("*/", "* /")} */` : "";
	}

	/** A local $ref such as #/$defs/Team. Others, and loops, are "unknown". */
	private resolve(ref: string, refs: Set<string>): unknown {
		if (refs.has(ref) || !ref.startsWith("#")) return undefined;
		let node: unknown = this.root;
		for (const segment of ref.slice(1).split("/").filter(Boolean)) {
			if (!isObject(node)) return undefined;
			node = node[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
		}
		return node;
	}
}

function union(types: string[]) {
	const unique = [...new Set(types)];
	return unique.length ? unique.join(" | ") : "never";
}

/** Parentheses around a union or intersection inside an array or intersection. */
const wrap = (type: string) => (joinsTypes(type) ? `(${type})` : type);

/** True when the type has a | or & outside braces, parentheses and strings. */
function joinsTypes(type: string) {
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < type.length; i++) {
		const char = type[i];
		if (quoted) {
			if (char === "\\") i++;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "{" || char === "(" || char === "[") depth++;
		else if (char === "}" || char === ")" || char === "]") depth--;
		else if (depth === 0 && (char === "|" || char === "&")) return true;
	}
	return false;
}
