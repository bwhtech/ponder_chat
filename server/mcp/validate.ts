import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * Checks a connector_call's input against the real tool's JSON schema, before the
 * person is asked to approve it. The same Ajv options WorkflowAgent uses for tools
 * (@ai-sdk/workflow), so a call passes or fails as it did when each connector tool
 * was a tool of its own. Pure: the workflow runs it, and a replay gets the same answer.
 */
const OPTIONS = { allErrors: true, strict: false, validateFormats: false };
const DRAFT_2020 = "https://json-schema.org/draft/2020-12/schema";

let draft7: Ajv | undefined;
let draft2020: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction | null>();

/** What is wrong with `value`, or an empty list. A schema Ajv can't read checks nothing: the server checks the call too. */
export function inputProblems(schema: Record<string, unknown>, value: unknown): string[] {
	const validate = compile(schema);
	if (!validate || validate(value)) return [];
	return (validate.errors ?? []).map(describe);
}

function compile(schema: Record<string, unknown>) {
	const key = JSON.stringify(schema);
	if (!compiled.has(key)) {
		try {
			compiled.set(key, ajvFor(schema).compile(schema));
		} catch {
			compiled.set(key, null);
		}
	}
	return compiled.get(key) ?? null;
}

function ajvFor(schema: Record<string, unknown>) {
	if (typeof schema.$schema === "string" && schema.$schema.replace(/#$/, "") === DRAFT_2020) return (draft2020 ??= new Ajv2020(OPTIONS));
	return (draft7 ??= new Ajv(OPTIONS));
}

/** Ajv's error, with the path as the model wrote it: input.team, input.labels.0. */
function describe(error: ErrorObject) {
	const path = `input${error.instancePath.replaceAll("/", ".")}`;
	const params = error.params as Record<string, unknown>;
	switch (error.keyword) {
		case "required":
			return `${path} is missing the required property ${JSON.stringify(params.missingProperty)}`;
		case "additionalProperties":
			return `${path} has a property the tool does not take: ${JSON.stringify(params.additionalProperty)}`;
		case "enum":
			return `${path} must be one of ${(params.allowedValues as unknown[]).map((value) => JSON.stringify(value)).join(", ")}`;
		default:
			return `${path} ${error.message ?? "is not valid"}`;
	}
}
